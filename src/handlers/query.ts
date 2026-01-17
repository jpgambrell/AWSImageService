/**
 * Query Lambda Handler
 * 
 * This Lambda handles all GET requests:
 * - GET /health - Health check
 * - GET /api/images - List all images
 * - GET /api/images/{imageId} - Get/download a specific image
 * - GET /api/images/{imageId}/info - Get image metadata
 * - GET /api/analysis - List all analysis results
 * - GET /api/analysis/{imageId} - Get analysis for specific image
 * 
 * This consolidates the query functionality from both the upload and analysis
 * services in the original application into a single Lambda for efficiency.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ApiResponse, ImageMetadata, ImageAnalysis } from '../types';

// Initialize AWS SDK clients
const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Environment variables
const BUCKET_NAME = process.env.BUCKET_NAME!;
const IMAGES_TABLE = process.env.IMAGES_TABLE!;
const ANALYSIS_TABLE = process.env.ANALYSIS_TABLE!;

/**
 * Lambda Handler
 * Routes requests based on path and method
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { path, httpMethod, pathParameters } = event;

  console.log(JSON.stringify({
    level: 'info',
    message: 'Query request received',
    action: 'query_start',
    path,
    httpMethod,
    pathParameters,
  }));

  try {
    // Route the request based on path
    // We use simple string matching since we know our routes
    
    // Health check
    if (path === '/health') {
      return healthCheck();
    }

    // List all images
    if (path === '/api/images' && httpMethod === 'GET') {
      return listImages();
    }

    // Get image info
    if (path.match(/^\/api\/images\/[^/]+\/info$/) && httpMethod === 'GET') {
      const imageId = pathParameters?.imageId;
      if (!imageId) return errorResponse(400, 'Image ID required');
      return getImageInfo(imageId);
    }

    // Get/download image
    if (path.match(/^\/api\/images\/[^/]+$/) && httpMethod === 'GET') {
      const imageId = pathParameters?.imageId;
      if (!imageId) return errorResponse(400, 'Image ID required');
      return getImage(imageId);
    }

    // List all analysis results
    if (path === '/api/analysis' && httpMethod === 'GET') {
      return listAnalysis();
    }

    // Get analysis for specific image
    if (path.match(/^\/api\/analysis\/[^/]+$/) && httpMethod === 'GET') {
      const imageId = pathParameters?.imageId;
      if (!imageId) return errorResponse(400, 'Image ID required');
      return getAnalysis(imageId);
    }

    // Route not found
    return errorResponse(404, 'Route not found');

  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Query failed',
      action: 'query_error',
      path,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));

    return errorResponse(500, 'Internal server error');
  }
}

/**
 * Health check endpoint
 */
async function healthCheck(): Promise<APIGatewayProxyResult> {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      status: 'healthy',
      service: 'aws-image-service',
      timestamp: new Date().toISOString(),
    }),
  };
}

/**
 * List all uploaded images
 * GET /api/images
 */
async function listImages(): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Listing all images',
    action: 'list_images',
  }));

  // Scan the images table
  // Note: For production with large datasets, use pagination or query with GSI
  const result = await docClient.send(new ScanCommand({
    TableName: IMAGES_TABLE,
  }));

  const images = result.Items as ImageMetadata[] || [];

  // Sort by uploadedAt descending (newest first)
  images.sort((a, b) => 
    new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );

  // Transform to match original API response format
  const responseImages = images.map(img => ({
    id: img.imageId,
    filename: img.filename,
    originalName: img.originalName,
    mimetype: img.mimetype,
    size: img.size,
    uploadedAt: img.uploadedAt,
    path: `/api/images/${img.imageId}`,
    status: img.status,
  }));

  const response: ApiResponse<typeof responseImages> = {
    success: true,
    data: responseImages,
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Get a specific image (redirect to presigned S3 URL)
 * GET /api/images/{imageId}
 * 
 * Instead of streaming the image through Lambda (expensive and slow),
 * we generate a presigned URL that allows direct download from S3.
 */
async function getImage(imageId: string): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Getting image',
    action: 'get_image',
    imageId,
  }));

  // First, get the image metadata to find the S3 key
  const result = await docClient.send(new GetCommand({
    TableName: IMAGES_TABLE,
    Key: { imageId },
  }));

  const image = result.Item as ImageMetadata | undefined;

  if (!image) {
    return errorResponse(404, 'Image not found');
  }

  // Generate a presigned URL for S3 (valid for 1 hour)
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: image.s3Key,
  });

  const presignedUrl = await getSignedUrl(s3Client, command, {
    expiresIn: 3600, // 1 hour
  });

  // Redirect to the presigned URL
  // This is efficient - the client downloads directly from S3
  return {
    statusCode: 302,
    headers: {
      ...corsHeaders(),
      'Location': presignedUrl,
    },
    body: '',
  };
}

/**
 * Get image metadata
 * GET /api/images/{imageId}/info
 */
async function getImageInfo(imageId: string): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Getting image info',
    action: 'get_image_info',
    imageId,
  }));

  const result = await docClient.send(new GetCommand({
    TableName: IMAGES_TABLE,
    Key: { imageId },
  }));

  const image = result.Item as ImageMetadata | undefined;

  if (!image) {
    return errorResponse(404, 'Image not found');
  }

  // Transform to match original API response format
  const responseData = {
    id: image.imageId,
    filename: image.filename,
    originalName: image.originalName,
    mimetype: image.mimetype,
    size: image.size,
    uploadedAt: image.uploadedAt,
    path: `/api/images/${image.imageId}`,
    status: image.status,
  };

  const response: ApiResponse<typeof responseData> = {
    success: true,
    data: responseData,
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * List all analysis results
 * GET /api/analysis
 */
async function listAnalysis(): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Listing all analysis results',
    action: 'list_analysis',
  }));

  const result = await docClient.send(new ScanCommand({
    TableName: ANALYSIS_TABLE,
  }));

  const analyses = result.Items as ImageAnalysis[] || [];

  // Sort by analyzedAt descending (newest first)
  analyses.sort((a, b) => {
    const dateA = a.analyzedAt ? new Date(a.analyzedAt).getTime() : 0;
    const dateB = b.analyzedAt ? new Date(b.analyzedAt).getTime() : 0;
    return dateB - dateA;
  });

  const response: ApiResponse<ImageAnalysis[]> = {
    success: true,
    data: analyses,
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Get analysis for a specific image
 * GET /api/analysis/{imageId}
 */
async function getAnalysis(imageId: string): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Getting analysis',
    action: 'get_analysis',
    imageId,
  }));

  const result = await docClient.send(new GetCommand({
    TableName: ANALYSIS_TABLE,
    Key: { imageId },
  }));

  const analysis = result.Item as ImageAnalysis | undefined;

  if (!analysis) {
    return errorResponse(404, 'Analysis not found');
  }

  const response: ApiResponse<ImageAnalysis> = {
    success: true,
    data: analysis,
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Create error response
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
 * Standard CORS headers
 */
function corsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key,X-Amz-Date,X-Amz-Security-Token,Accept,Accept-Encoding',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  };
}

