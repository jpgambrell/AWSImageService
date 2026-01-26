/**
 * Query Lambda Handler
 * 
 * This Lambda handles all GET and DELETE requests:
 * - GET /health - Health check
 * - GET /api/images - List all images
 * - GET /api/images/{imageId} - Get/download a specific image
 * - GET /api/images/{imageId}/info - Get image metadata
 * - DELETE /api/images/{imageId} - Delete an image and all associated data
 * - GET /api/analysis - List all analysis results
 * - GET /api/analysis/{imageId} - Get analysis for specific image
 * 
 * This consolidates the query functionality from both the upload and analysis
 * services in the original application into a single Lambda for efficiency.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ApiResponse, ImageMetadata, ImageAnalysis, JwtClaims } from '../types';
import { extractUserClaims, isAdmin } from './auth';

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
  const { path, httpMethod, pathParameters, queryStringParameters } = event;

  // Extract user claims for protected routes (will be null for /health)
  const claims = extractUserClaims(event);
  const userId = claims?.sub;
  const userIsAdmin = claims ? isAdmin(claims) : false;

  console.log(JSON.stringify({
    level: 'info',
    message: 'Query request received',
    action: 'query_start',
    path,
    httpMethod,
    pathParameters,
    userId,
    isAdmin: userIsAdmin,
  }));

  try {
    // Route the request based on path
    // We use simple string matching since we know our routes
    
    // Health check (public - no auth required)
    if (path === '/health') {
      return healthCheck();
    }

    // All other routes require authentication
    if (!claims || !userId) {
      return errorResponse(401, 'Unauthorized - valid token required');
    }

    // For admin users, allow optional userId query param to filter by specific user
    const targetUserId = userIsAdmin && queryStringParameters?.userId 
      ? queryStringParameters.userId 
      : userId;

    // List all images (filtered by user unless admin)
    if (path === '/api/images' && httpMethod === 'GET') {
      return listImages(targetUserId, userIsAdmin);
    }

    // Get image info
    if (path.match(/^\/api\/images\/[^/]+\/info$/) && httpMethod === 'GET') {
      const imageId = pathParameters?.imageId;
      if (!imageId) return errorResponse(400, 'Image ID required');
      return getImageInfo(imageId, userId, userIsAdmin);
    }

    // Get/download image
    if (path.match(/^\/api\/images\/[^/]+$/) && httpMethod === 'GET') {
      const imageId = pathParameters?.imageId;
      if (!imageId) return errorResponse(400, 'Image ID required');
      return getImage(imageId, userId, userIsAdmin);
    }

    // Delete image
    if (path.match(/^\/api\/images\/[^/]+$/) && httpMethod === 'DELETE') {
      const imageId = pathParameters?.imageId;
      if (!imageId) return errorResponse(400, 'Image ID required');
      return deleteImage(imageId, userId, userIsAdmin);
    }

    // List all analysis results (filtered by user unless admin)
    if (path === '/api/analysis' && httpMethod === 'GET') {
      return listAnalysis(targetUserId, userIsAdmin);
    }

    // Get analysis for specific image
    if (path.match(/^\/api\/analysis\/[^/]+$/) && httpMethod === 'GET') {
      const imageId = pathParameters?.imageId;
      if (!imageId) return errorResponse(400, 'Image ID required');
      return getAnalysis(imageId, userId, userIsAdmin);
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
 * List uploaded images for a user
 * GET /api/images
 * 
 * Regular users see only their images.
 * Admin users can see all images or filter by userId query param.
 */
async function listImages(userId: string, isAdminUser: boolean): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Listing images',
    action: 'list_images',
    userId,
    isAdmin: isAdminUser,
  }));

  let images: ImageMetadata[] = [];

  if (isAdminUser && !userId) {
    // Admin without filter - scan all images
    const result = await docClient.send(new ScanCommand({
      TableName: IMAGES_TABLE,
    }));
    images = result.Items as ImageMetadata[] || [];
  } else {
    // Query by userId using GSI
    const result = await docClient.send(new QueryCommand({
      TableName: IMAGES_TABLE,
      IndexName: 'userId-uploadedAt-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
      ScanIndexForward: false, // Descending order (newest first)
    }));
    images = result.Items as ImageMetadata[] || [];
  }

  // For scan results (admin all), sort by uploadedAt descending
  if (isAdminUser && !userId) {
    images.sort((a, b) => 
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );
  }

  // Transform to match original API response format
  const responseImages = images.map(img => ({
    id: img.imageId,
    userId: img.userId,
    filename: img.filename,
    originalName: img.originalName,
    mimetype: img.mimetype,
    size: img.size,
    uploadedAt: img.uploadedAt,
    path: `/api/images/${img.imageId}`,
    status: img.status,
    ...(img.latitude !== undefined && { latitude: img.latitude }),
    ...(img.longitude !== undefined && { longitude: img.longitude }),
    ...(img.creationDate && { creationDate: img.creationDate }),
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
 * 
 * Users can only access their own images unless they are admin.
 */
async function getImage(imageId: string, userId: string, isAdminUser: boolean): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Getting image',
    action: 'get_image',
    imageId,
    userId,
    isAdmin: isAdminUser,
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

  // Check ownership (unless admin)
  if (!isAdminUser && image.userId && image.userId !== userId) {
    return errorResponse(403, 'Access denied - you can only access your own images');
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
 * 
 * Users can only access their own images unless they are admin.
 */
async function getImageInfo(imageId: string, userId: string, isAdminUser: boolean): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Getting image info',
    action: 'get_image_info',
    imageId,
    userId,
    isAdmin: isAdminUser,
  }));

  const result = await docClient.send(new GetCommand({
    TableName: IMAGES_TABLE,
    Key: { imageId },
  }));

  const image = result.Item as ImageMetadata | undefined;

  if (!image) {
    return errorResponse(404, 'Image not found');
  }

  // Check ownership (unless admin)
  if (!isAdminUser && image.userId && image.userId !== userId) {
    return errorResponse(403, 'Access denied - you can only access your own images');
  }

  // Transform to match original API response format
  const responseData = {
    id: image.imageId,
    userId: image.userId,
    filename: image.filename,
    originalName: image.originalName,
    mimetype: image.mimetype,
    size: image.size,
    uploadedAt: image.uploadedAt,
    path: `/api/images/${image.imageId}`,
    status: image.status,
    ...(image.latitude !== undefined && { latitude: image.latitude }),
    ...(image.longitude !== undefined && { longitude: image.longitude }),
    ...(image.creationDate && { creationDate: image.creationDate }),
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
 * Delete an image and all associated data
 * DELETE /api/images/{imageId}
 * 
 * This removes:
 * - The image file from S3
 * - Image metadata from DynamoDB
 * - Any AI analysis results from DynamoDB
 * 
 * Users can only delete their own images unless they are admin.
 */
async function deleteImage(imageId: string, userId: string, isAdminUser: boolean): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Deleting image',
    action: 'delete_image',
    imageId,
    userId,
    isAdmin: isAdminUser,
  }));

  // First, get the image metadata to find the S3 key and verify ownership
  const result = await docClient.send(new GetCommand({
    TableName: IMAGES_TABLE,
    Key: { imageId },
  }));

  const image = result.Item as ImageMetadata | undefined;

  if (!image) {
    return errorResponse(404, 'Image not found');
  }

  // Check ownership (unless admin)
  if (!isAdminUser && image.userId && image.userId !== userId) {
    return errorResponse(403, 'Access denied - you can only delete your own images');
  }

  try {
    // Step 1: Delete the image file from S3
    await s3Client.send(new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: image.s3Key,
    }));

    console.log(JSON.stringify({
      level: 'info',
      message: 'Image deleted from S3',
      action: 'delete_s3',
      imageId,
      s3Key: image.s3Key,
    }));

    // Step 2: Delete image metadata from DynamoDB
    await docClient.send(new DeleteCommand({
      TableName: IMAGES_TABLE,
      Key: { imageId },
    }));

    console.log(JSON.stringify({
      level: 'info',
      message: 'Image metadata deleted from DynamoDB',
      action: 'delete_metadata',
      imageId,
    }));

    // Step 3: Delete analysis data from DynamoDB (if exists)
    // We don't check if it exists first - just attempt to delete
    await docClient.send(new DeleteCommand({
      TableName: ANALYSIS_TABLE,
      Key: { imageId },
    }));

    console.log(JSON.stringify({
      level: 'info',
      message: 'Analysis data deleted from DynamoDB',
      action: 'delete_analysis',
      imageId,
    }));

    const response: ApiResponse<null> = {
      success: true,
      message: 'Image and all associated data deleted successfully',
    };

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify(response),
    };

  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Failed to delete image',
      action: 'delete_error',
      imageId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));

    return errorResponse(500, 'Failed to delete image');
  }
}

/**
 * List analysis results for a user
 * GET /api/analysis
 * 
 * Regular users see only their analysis results.
 * Admin users can see all analysis or filter by userId query param.
 */
async function listAnalysis(userId: string, isAdminUser: boolean): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Listing analysis results',
    action: 'list_analysis',
    userId,
    isAdmin: isAdminUser,
  }));

  let analyses: ImageAnalysis[] = [];

  if (isAdminUser && !userId) {
    // Admin without filter - scan all analysis results
    const result = await docClient.send(new ScanCommand({
      TableName: ANALYSIS_TABLE,
    }));
    analyses = result.Items as ImageAnalysis[] || [];
  } else {
    // Query by userId using GSI
    const result = await docClient.send(new QueryCommand({
      TableName: ANALYSIS_TABLE,
      IndexName: 'userId-analyzedAt-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
      ScanIndexForward: false, // Descending order (newest first)
    }));
    analyses = result.Items as ImageAnalysis[] || [];
  }

  // For scan results (admin all), sort by analyzedAt descending
  if (isAdminUser && !userId) {
    analyses.sort((a, b) => {
      const dateA = a.analyzedAt ? new Date(a.analyzedAt).getTime() : 0;
      const dateB = b.analyzedAt ? new Date(b.analyzedAt).getTime() : 0;
      return dateB - dateA;
    });
  }

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
 * 
 * Users can only access their own analysis unless they are admin.
 */
async function getAnalysis(imageId: string, userId: string, isAdminUser: boolean): Promise<APIGatewayProxyResult> {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Getting analysis',
    action: 'get_analysis',
    imageId,
    userId,
    isAdmin: isAdminUser,
  }));

  const result = await docClient.send(new GetCommand({
    TableName: ANALYSIS_TABLE,
    Key: { imageId },
  }));

  const analysis = result.Item as ImageAnalysis | undefined;

  if (!analysis) {
    return errorResponse(404, 'Analysis not found');
  }

  // Check ownership (unless admin)
  if (!isAdminUser && analysis.userId && analysis.userId !== userId) {
    return errorResponse(403, 'Access denied - you can only access your own analysis');
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

