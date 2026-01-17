/**
 * Shared TypeScript types for the AWS Image Service
 * These mirror the data structures from the original KafkaImageService
 */

// ============================================
// IMAGE METADATA
// ============================================

/**
 * Represents an uploaded image's metadata
 * Stored in DynamoDB 'images' table
 */
export interface ImageMetadata {
  imageId: string;          // UUID - Primary Key in DynamoDB
  filename: string;         // Stored filename (uuid.ext)
  originalName: string;     // Original upload filename
  mimetype: string;         // MIME type (image/jpeg, etc.)
  size: number;             // File size in bytes
  uploadedAt: string;       // ISO timestamp
  s3Key: string;            // S3 object key for retrieval
  status: 'uploaded' | 'processing' | 'analyzed' | 'failed';
}

// ============================================
// IMAGE ANALYSIS
// ============================================

/**
 * Represents AI analysis results for an image
 * Stored in DynamoDB 'image_analysis' table
 */
export interface ImageAnalysis {
  imageId: string;          // UUID - Primary Key (same as image)
  filename: string;         // Image filename
  description: string;      // AI-generated description
  keywords: string[];       // Extracted keywords/tags
  detectedText: string[];   // Text found in image (addresses, signs, etc.)
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;           // Error message if failed
  analyzedAt?: string;      // ISO timestamp when analysis completed
}

// ============================================
// SQS MESSAGE
// ============================================

/**
 * Message sent to SQS when an image is uploaded
 * Triggers the analysis Lambda
 */
export interface ImageUploadMessage {
  imageId: string;
  filename: string;
  s3Key: string;
  mimetype: string;
  uploadedAt: string;
  correlationId: string;    // For tracing through the system
}

// ============================================
// API RESPONSES
// ============================================

/**
 * Standard API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}

/**
 * Upload response data
 */
export interface UploadResponseData {
  id: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  uploadedAt: string;
  path: string;             // API path to retrieve the image
}

// ============================================
// LAMBDA EVENT TYPES
// ============================================

/**
 * Parsed multipart form data from API Gateway
 */
export interface ParsedMultipartData {
  filename: string;
  contentType: string;
  content: Buffer;
}

// ============================================
// CONFIGURATION
// ============================================

/**
 * Allowed image MIME types
 */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png', 
  'image/gif',
  'image/webp'
] as const;

/**
 * Maximum file size (10MB)
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * File extension mapping
 */
export const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

