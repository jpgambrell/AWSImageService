/**
 * Upload Lambda Handler
 * 
 * This is the AWS Lambda equivalent of the Express upload controller.
 * 
 * What it does:
 * 1. Receives image upload via API Gateway (multipart/form-data)
 * 2. Validates file type and size
 * 3. Saves image to S3
 * 4. Saves metadata to DynamoDB
 * 5. Sends message to SQS for analysis processing
 * 
 * Key differences from Express version:
 * - No multer middleware - we parse multipart data manually
 * - Uses AWS SDK v3 instead of file system
 * - Stateless - no persistent connections
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { v4 as uuidv4 } from 'uuid';
import {
  ImageMetadata,
  ImageUploadMessage,
  ApiResponse,
  UploadResponseData,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MIME_TO_EXTENSION,
} from '../types';

// Initialize AWS SDK clients
// These are created once when Lambda starts (cold start) and reused for subsequent invocations (warm starts)
const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sqsClient = new SQSClient({});

// Environment variables (set in CDK stack)
const BUCKET_NAME = process.env.BUCKET_NAME!;
const IMAGES_TABLE = process.env.IMAGES_TABLE!;
const QUEUE_URL = process.env.QUEUE_URL!;

/**
 * Lambda Handler Function
 * 
 * This is the entry point that AWS Lambda calls.
 * The event contains the HTTP request from API Gateway.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Generate correlation ID for tracing through the system
  const correlationId = uuidv4();
  
  console.log(JSON.stringify({
    level: 'info',
    message: 'Upload request received',
    correlationId,
    action: 'upload_start',
    path: event.path,
    httpMethod: event.httpMethod,
    isBase64Encoded: event.isBase64Encoded,
    contentType: event.headers['Content-Type'] || event.headers['content-type'],
    bodyLength: event.body?.length || 0,
  }));

  try {
    // Parse the multipart form data from the request
    const formData = parseMultipartFormData(event);
    
    if (!formData) {
      console.log(JSON.stringify({
        level: 'warn',
        message: 'Failed to parse multipart data',
        correlationId,
        hasBody: !!event.body,
        bodyLength: event.body?.length || 0,
        isBase64Encoded: event.isBase64Encoded,
        headers: event.headers,
      }));
      return errorResponse(400, 'No file uploaded or invalid multipart data');
    }

    const { filename: originalName, contentType, content } = formData;

    // Validate file type
    if (!ALLOWED_MIME_TYPES.includes(contentType as any)) {
      console.log(JSON.stringify({
        level: 'warn',
        message: 'Invalid file type',
        correlationId,
        contentType,
        allowedTypes: ALLOWED_MIME_TYPES,
      }));
      return errorResponse(400, `Invalid file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`);
    }

    // Validate file size
    if (content.length > MAX_FILE_SIZE) {
      console.log(JSON.stringify({
        level: 'warn',
        message: 'File too large',
        correlationId,
        size: content.length,
        maxSize: MAX_FILE_SIZE,
      }));
      return errorResponse(400, `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }

    // Generate unique ID and filename
    const imageId = uuidv4();
    const extension = MIME_TO_EXTENSION[contentType] || '.jpg';
    const storedFilename = `${imageId}${extension}`;
    const s3Key = `images/${storedFilename}`;

    console.log(JSON.stringify({
      level: 'info',
      message: 'Processing upload',
      correlationId,
      imageId,
      originalName,
      contentType,
      size: content.length,
    }));

    // Step 1: Upload image to S3
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: content,
      ContentType: contentType,
      Metadata: {
        'original-name': originalName,
        'correlation-id': correlationId,
      },
    }));

    console.log(JSON.stringify({
      level: 'info',
      message: 'Image saved to S3',
      correlationId,
      imageId,
      action: 's3_upload',
      bucket: BUCKET_NAME,
      key: s3Key,
    }));

    // Step 2: Save metadata to DynamoDB
    const now = new Date().toISOString();
    const imageMetadata: ImageMetadata = {
      imageId,
      filename: storedFilename,
      originalName,
      mimetype: contentType,
      size: content.length,
      uploadedAt: now,
      s3Key,
      status: 'uploaded',
    };

    await docClient.send(new PutCommand({
      TableName: IMAGES_TABLE,
      Item: imageMetadata,
    }));

    console.log(JSON.stringify({
      level: 'info',
      message: 'Metadata saved to DynamoDB',
      correlationId,
      imageId,
      action: 'db_save',
    }));

    // Step 3: Send message to SQS for analysis
    const sqsMessage: ImageUploadMessage = {
      imageId,
      filename: storedFilename,
      s3Key,
      mimetype: contentType,
      uploadedAt: now,
      correlationId,
    };

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(sqsMessage),
      // Message attributes for filtering/routing if needed later
      MessageAttributes: {
        imageId: {
          DataType: 'String',
          StringValue: imageId,
        },
        correlationId: {
          DataType: 'String',
          StringValue: correlationId,
        },
      },
    }));

    console.log(JSON.stringify({
      level: 'info',
      message: 'Message sent to SQS',
      correlationId,
      imageId,
      action: 'sqs_publish',
    }));

    // Build success response (matches original API response format)
    const responseData: UploadResponseData = {
      id: imageId,
      filename: storedFilename,
      originalName,
      mimetype: contentType,
      size: content.length,
      uploadedAt: now,
      path: `/api/images/${imageId}`,
    };

    const response: ApiResponse<UploadResponseData> = {
      success: true,
      message: 'Image uploaded successfully',
      data: responseData,
    };

    console.log(JSON.stringify({
      level: 'info',
      message: 'Upload completed successfully',
      correlationId,
      imageId,
      action: 'upload_complete',
    }));

    return {
      statusCode: 201,
      headers: corsHeaders(),
      body: JSON.stringify(response),
    };

  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Upload failed',
      correlationId,
      action: 'upload_error',
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }));

    return errorResponse(500, 'Failed to upload image');
  }
}

/**
 * Parse multipart/form-data from API Gateway event
 * 
 * API Gateway sends the request body as base64-encoded when binary media types are enabled.
 * We need to decode it and parse the multipart boundary to extract the file.
 */
function parseMultipartFormData(event: APIGatewayProxyEvent): {
  filename: string;
  contentType: string;
  content: Buffer;
} | null {
  if (!event.body) {
    return null;
  }

  // Decode body (API Gateway base64 encodes binary data)
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body);

  // Get the boundary from Content-Type header
  const contentType = event.headers['Content-Type'] || event.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  
  if (!boundaryMatch) {
    console.log('No boundary found in Content-Type header');
    return null;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  
  console.log(JSON.stringify({
    level: 'debug',
    message: 'Parsing multipart',
    boundary,
    boundaryBufferLength: boundaryBuffer.length,
    bodyLength: body.length,
    bodyStart: body.slice(0, 200).toString('utf8').replace(/[\x00-\x1f]/g, '.'),
  }));

  // Split body by boundary
  const parts = splitByBoundary(body, boundaryBuffer);
  
  console.log(JSON.stringify({
    level: 'debug',
    message: 'Split body into parts',
    partCount: parts.length,
    partLengths: parts.map(p => p.length),
  }));

  for (const part of parts) {
    // Parse headers from this part
    const headerEndIndex = part.indexOf('\r\n\r\n');
    if (headerEndIndex === -1) {
      console.log(JSON.stringify({ level: 'debug', message: 'Part has no header end', partLength: part.length }));
      continue;
    }

    const headerSection = part.slice(0, headerEndIndex).toString();
    const content = part.slice(headerEndIndex + 4);
    
    console.log(JSON.stringify({
      level: 'debug',
      message: 'Found part',
      headerSection: headerSection.substring(0, 200),
      contentLength: content.length,
    }));

    // Check if this is a file field
    // Use non-greedy matching (.*?) to ensure we get the first name= attribute
    const nameMatch = headerSection.match(/Content-Disposition:[^;]*;[^;]*name="([^"]+)"/i);
    const filenameMatch = headerSection.match(/filename="([^"]+)"/i);
    
    if (!nameMatch) {
      console.log(JSON.stringify({ level: 'debug', message: 'No name match in header', headerSection }));
      continue;
    }

    const fieldName = nameMatch[1];
    const filename = filenameMatch ? filenameMatch[1] : undefined;
    
    console.log(JSON.stringify({
      level: 'debug',
      message: 'Found field',
      fieldName,
      filename,
    }));

    // We're looking for the 'image' field (or any file field)
    if (filename && (fieldName === 'image' || fieldName === 'file')) {
      // Get content type of the file
      const fileContentTypeMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);
      const fileContentType = fileContentTypeMatch ? fileContentTypeMatch[1].trim() : 'application/octet-stream';

      // Remove trailing boundary markers if present
      let cleanContent = content;
      const trailingBoundaryIndex = content.lastIndexOf(boundaryBuffer);
      if (trailingBoundaryIndex > 0) {
        cleanContent = content.slice(0, trailingBoundaryIndex - 2); // -2 for \r\n before boundary
      }

      // Remove trailing \r\n if present
      if (cleanContent.length >= 2 && 
          cleanContent[cleanContent.length - 2] === 0x0d && 
          cleanContent[cleanContent.length - 1] === 0x0a) {
        cleanContent = cleanContent.slice(0, -2);
      }

      return {
        filename,
        contentType: fileContentType,
        content: cleanContent,
      };
    }
  }

  return null;
}

/**
 * Split buffer by boundary
 */
function splitByBoundary(buffer: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;

  while (true) {
    const boundaryIndex = buffer.indexOf(boundary, start);
    if (boundaryIndex === -1) break;

    if (start > 0) {
      // Get content between previous boundary and this one
      // Skip the \r\n after the boundary
      let partStart = start;
      if (buffer[partStart] === 0x0d && buffer[partStart + 1] === 0x0a) {
        partStart += 2;
      }
      
      // End before the \r\n preceding the boundary
      let partEnd = boundaryIndex;
      if (partEnd >= 2 && buffer[partEnd - 2] === 0x0d && buffer[partEnd - 1] === 0x0a) {
        partEnd -= 2;
      }

      if (partEnd > partStart) {
        parts.push(buffer.slice(partStart, partEnd));
      }
    }

    start = boundaryIndex + boundary.length;
    
    // Check for closing boundary (--)
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) {
      break;
    }
  }

  return parts;
}

/**
 * Create error response with CORS headers
 */
function errorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  const response: ApiResponse<null> = {
    success: false,
    error: message,
  };

  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Standard CORS headers for API responses
 */
function corsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}

