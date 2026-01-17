/**
 * Analysis Lambda Handler
 * 
 * This is the AWS Lambda equivalent of the Kafka consumer + Ollama service.
 * 
 * What it does:
 * 1. Triggered by SQS messages (when an image is uploaded)
 * 2. Retrieves the image from S3
 * 3. Calls Amazon Bedrock Claude Vision for AI analysis
 * 4. Extracts description, keywords, and detected text
 * 5. Saves results to DynamoDB
 * 
 * Key differences from Kafka/Ollama version:
 * - SQS trigger instead of Kafka consumer
 * - Amazon Bedrock instead of Ollama
 * - Claude 3 Sonnet instead of LLaVA
 */

import { SQSEvent, SQSRecord } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { ImageUploadMessage, ImageAnalysis } from '../types';

// Initialize AWS SDK clients
const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const bedrockClient = new BedrockRuntimeClient({});

// Environment variables
const BUCKET_NAME = process.env.BUCKET_NAME!;
const IMAGES_TABLE = process.env.IMAGES_TABLE!;
const ANALYSIS_TABLE = process.env.ANALYSIS_TABLE!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID!;

/**
 * Lambda Handler for SQS Events
 * 
 * SQS sends batches of messages. We process each one.
 * If processing fails, the message returns to the queue for retry.
 */
export async function handler(event: SQSEvent): Promise<void> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Analysis Lambda invoked',
    action: 'lambda_start',
    recordCount: event.Records.length,
  }));

  // Process each message (batch size is 1 in our CDK config, but handle multiple just in case)
  for (const record of event.Records) {
    await processRecord(record);
  }
}

/**
 * Process a single SQS message
 */
async function processRecord(record: SQSRecord): Promise<void> {
  let imageId: string = '';
  let correlationId: string = '';

  try {
    // Parse the message body
    const message: ImageUploadMessage = JSON.parse(record.body);
    imageId = message.imageId;
    correlationId = message.correlationId;

    console.log(JSON.stringify({
      level: 'info',
      message: 'Processing image analysis',
      imageId,
      correlationId,
      action: 'analysis_start',
      filename: message.filename,
    }));

    // Update image status to 'processing'
    await updateImageStatus(imageId, 'processing');

    // Create initial analysis record with 'processing' status
    const initialAnalysis: ImageAnalysis = {
      imageId,
      filename: message.filename,
      description: '',
      keywords: [],
      detectedText: [],
      status: 'processing',
    };

    await docClient.send(new PutCommand({
      TableName: ANALYSIS_TABLE,
      Item: initialAnalysis,
    }));

    // Step 1: Get image from S3
    console.log(JSON.stringify({
      level: 'info',
      message: 'Retrieving image from S3',
      imageId,
      correlationId,
      action: 's3_get',
      s3Key: message.s3Key,
    }));

    const s3Response = await s3Client.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: message.s3Key,
    }));

    // Convert stream to buffer
    const imageBytes = await s3Response.Body?.transformToByteArray();
    if (!imageBytes) {
      throw new Error('Failed to read image from S3');
    }

    // Convert to base64 for Bedrock
    const imageBase64 = Buffer.from(imageBytes).toString('base64');

    // Determine media type for Bedrock
    const mediaType = getMediaType(message.mimetype);

    console.log(JSON.stringify({
      level: 'info',
      message: 'Image retrieved, calling Bedrock',
      imageId,
      correlationId,
      action: 'bedrock_call',
      imageSize: imageBytes.length,
      mediaType,
    }));

    // Step 2: Call Amazon Bedrock Claude Vision
    const analysisResult = await analyzeWithBedrock(imageBase64, mediaType);

    console.log(JSON.stringify({
      level: 'info',
      message: 'Bedrock analysis completed',
      imageId,
      correlationId,
      action: 'bedrock_response',
      keywordCount: analysisResult.keywords.length,
      detectedTextCount: analysisResult.detectedText.length,
      descriptionLength: analysisResult.description.length,
    }));

    // Step 3: Save analysis results to DynamoDB
    const now = new Date().toISOString();
    const finalAnalysis: ImageAnalysis = {
      imageId,
      filename: message.filename,
      description: analysisResult.description,
      keywords: analysisResult.keywords,
      detectedText: analysisResult.detectedText,
      status: 'completed',
      analyzedAt: now,
    };

    await docClient.send(new PutCommand({
      TableName: ANALYSIS_TABLE,
      Item: finalAnalysis,
    }));

    // Update image status to 'analyzed'
    await updateImageStatus(imageId, 'analyzed');

    console.log(JSON.stringify({
      level: 'info',
      message: 'Image analysis completed',
      imageId,
      correlationId,
      action: 'analysis_complete',
      keywords: analysisResult.keywords,
      detectedText: analysisResult.detectedText,
    }));

  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Analysis failed',
      imageId,
      correlationId,
      action: 'analysis_error',
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }));

    // Save failed status to DynamoDB
    if (imageId) {
      try {
        await docClient.send(new PutCommand({
          TableName: ANALYSIS_TABLE,
          Item: {
            imageId,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error',
            analyzedAt: new Date().toISOString(),
          } as ImageAnalysis,
        }));

        await updateImageStatus(imageId, 'failed');
      } catch (dbError) {
        console.error('Failed to save error status:', dbError);
      }
    }

    // Rethrow to trigger SQS retry
    throw error;
  }
}

/**
 * Call Amazon Bedrock Claude Vision for image analysis
 * 
 * This replaces the Ollama/LLaVA call from the original service.
 * Claude 3 Sonnet has excellent vision capabilities and can:
 * - Describe images in detail
 * - Extract text (OCR)
 * - Identify objects, people, and scenes
 */
async function analyzeWithBedrock(
  imageBase64: string,
  mediaType: string
): Promise<{
  description: string;
  keywords: string[];
  detectedText: string[];
}> {
  // Construct the prompt - similar to the original Ollama prompt but enhanced
  const prompt = `Analyze this image in detail and provide the following information:

1. DESCRIPTION: Write a detailed description (2-4 sentences) of what is shown in the image. Describe the main subjects, setting, colors, and any notable details.

2. KEYWORDS: List exactly 5 keywords or short phrases that best describe the main elements, objects, themes, or concepts in the image.

3. DETECTED_TEXT: List ALL text visible in the image, including:
   - Signs, labels, or banners
   - Addresses or street names
   - Business names or logos with text
   - Any other readable text
   If no text is visible, respond with "No text detected"

Please format your response EXACTLY as follows (this format is critical for parsing):
DESCRIPTION: [your description here]
KEYWORDS: [keyword1, keyword2, keyword3, keyword4, keyword5]
DETECTED_TEXT: [text1, text2, text3] or [No text detected]`;

  // Bedrock Claude API request format
  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  };

  const command = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(requestBody),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  // Claude's response is in content[0].text
  const responseText = responseBody.content?.[0]?.text || '';

  console.log(JSON.stringify({
    level: 'debug',
    message: 'Raw Bedrock response',
    responseLength: responseText.length,
    responsePreview: responseText.substring(0, 500),
  }));

  // Parse the structured response
  return parseBedrockResponse(responseText);
}

/**
 * Parse Claude's response into structured data
 * Similar to the original OllamaService.parseResponse() method
 */
function parseBedrockResponse(responseText: string): {
  description: string;
  keywords: string[];
  detectedText: string[];
} {
  const result = {
    description: '',
    keywords: [] as string[],
    detectedText: [] as string[],
  };

  try {
    // Extract description
    const descMatch = responseText.match(/DESCRIPTION:\s*(.+?)(?=\nKEYWORDS:|$)/is);
    if (descMatch) {
      result.description = descMatch[1].trim();
    }

    // Extract keywords
    const keywordsMatch = responseText.match(/KEYWORDS:\s*(.+?)(?=\nDETECTED_TEXT:|$)/is);
    if (keywordsMatch) {
      const keywordsStr = keywordsMatch[1].trim();
      result.keywords = keywordsStr
        .replace(/[\[\]]/g, '')
        .split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0)
        .slice(0, 5);
    }

    // Extract detected text
    const textMatch = responseText.match(/DETECTED_TEXT:\s*(.+?)$/is);
    if (textMatch) {
      const textStr = textMatch[1].trim();
      if (textStr.toLowerCase().includes('no text detected')) {
        result.detectedText = [];
      } else {
        result.detectedText = textStr
          .replace(/[\[\]]/g, '')
          .split(',')
          .map(t => t.trim())
          .filter(t => t.length > 0 && !t.toLowerCase().includes('no text'));
      }
    }

    // Fallbacks if parsing failed
    if (!result.description) {
      result.description = responseText.substring(0, 300);
    }
    if (result.keywords.length === 0) {
      result.keywords = ['image', 'analysis', 'content', 'visual', 'photo'];
    }

    console.log(JSON.stringify({
      level: 'debug',
      message: 'Bedrock response parsed',
      keywordCount: result.keywords.length,
      detectedTextCount: result.detectedText.length,
    }));

  } catch (error) {
    console.error('Error parsing Bedrock response:', error);
    result.description = 'Analysis completed but response parsing failed';
    result.keywords = ['image', 'content'];
    result.detectedText = [];
  }

  return result;
}

/**
 * Update image status in the images table
 */
async function updateImageStatus(
  imageId: string,
  status: 'processing' | 'analyzed' | 'failed'
): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: IMAGES_TABLE,
    Key: { imageId },
    UpdateExpression: 'SET #status = :status',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':status': status,
    },
  }));
}

/**
 * Convert MIME type to Bedrock media type
 */
function getMediaType(mimetype: string): string {
  const mapping: Record<string, string> = {
    'image/jpeg': 'image/jpeg',
    'image/png': 'image/png',
    'image/gif': 'image/gif',
    'image/webp': 'image/webp',
  };
  return mapping[mimetype] || 'image/jpeg';
}

