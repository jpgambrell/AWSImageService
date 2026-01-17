import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

/**
 * AWS Image Service Stack
 * 
 * This CDK stack creates a serverless image upload and analysis system:
 * 
 * Flow:
 * 1. Client uploads image via API Gateway → Upload Lambda
 * 2. Upload Lambda saves image to S3, metadata to DynamoDB, sends message to SQS
 * 3. SQS triggers Analysis Lambda
 * 4. Analysis Lambda reads image from S3, calls Bedrock Claude Vision, saves results to DynamoDB
 * 5. Client queries results via API Gateway → Query Lambda → DynamoDB
 */
export class AwsImageServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ============================================
    // S3 BUCKET - Image Storage
    // ============================================
    // This replaces the shared Docker volume from the local setup
    // S3 provides durable, scalable storage with pay-per-use pricing
    
    const imageBucket = new s3.Bucket(this, 'ImageBucket', {
      bucketName: `image-service-bucket-${this.account}-${this.region}`,
      // Allow bucket to be deleted when stack is destroyed (for dev/testing)
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Block all public access - images served through API only
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // Enable versioning for safety (optional, can disable to save costs)
      versioned: false,
      // CORS configuration for direct browser uploads (if needed later)
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    // ============================================
    // DYNAMODB TABLES - Metadata Storage
    // ============================================
    // Replaces PostgreSQL from local setup
    // DynamoDB is serverless, pay-per-request, auto-scaling
    
    // Images table - stores upload metadata
    const imagesTable = new dynamodb.Table(this, 'ImagesTable', {
      tableName: 'image-service-images',
      partitionKey: { 
        name: 'imageId', 
        type: dynamodb.AttributeType.STRING 
      },
      // On-demand billing = pay only for what you use (cost efficient for variable traffic)
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Allow table deletion when stack is destroyed
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // Enable point-in-time recovery for production (disabled for dev to save costs)
      pointInTimeRecovery: false,
    });

    // Add Global Secondary Index for listing images by status
    imagesTable.addGlobalSecondaryIndex({
      indexName: 'status-uploadedAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'uploadedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Image Analysis table - stores AI analysis results
    const analysisTable = new dynamodb.Table(this, 'AnalysisTable', {
      tableName: 'image-service-analysis',
      partitionKey: { 
        name: 'imageId', 
        type: dynamodb.AttributeType.STRING 
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: false,
    });

    // Add GSI for listing analysis by status
    analysisTable.addGlobalSecondaryIndex({
      indexName: 'status-analyzedAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'analyzedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ============================================
    // SQS QUEUE - Async Processing
    // ============================================
    // Replaces Kafka from local setup
    // SQS is simpler, fully managed, pay-per-message
    
    // Dead Letter Queue - catches failed messages after retries
    const deadLetterQueue = new sqs.Queue(this, 'ImageProcessingDLQ', {
      queueName: 'image-processing-dlq',
      retentionPeriod: cdk.Duration.days(14), // Keep failed messages for debugging
    });

    // Main processing queue
    const imageQueue = new sqs.Queue(this, 'ImageProcessingQueue', {
      queueName: 'image-processing-queue',
      // How long a message is hidden while being processed
      visibilityTimeout: cdk.Duration.seconds(300), // 5 minutes for AI analysis
      // How long messages stay in queue if not processed
      retentionPeriod: cdk.Duration.days(4),
      // Dead letter queue configuration
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3, // Move to DLQ after 3 failed attempts
      },
    });

    // ============================================
    // LAMBDA FUNCTIONS
    // ============================================
    // Replaces Express services from local setup
    // Lambda is serverless - pay only when code runs
    
    // Common Lambda configuration
    const lambdaEnvironment = {
      BUCKET_NAME: imageBucket.bucketName,
      IMAGES_TABLE: imagesTable.tableName,
      ANALYSIS_TABLE: analysisTable.tableName,
      QUEUE_URL: imageQueue.queueUrl,
      // Bedrock model - Claude 3 Sonnet with vision capabilities
      BEDROCK_MODEL_ID: 'anthropic.claude-3-sonnet-20240229-v1:0',
      NODE_OPTIONS: '--enable-source-maps',
    };

    // --- Upload Lambda ---
    // Handles image uploads from API Gateway
    const uploadLambda = new lambdaNodejs.NodejsFunction(this, 'UploadFunction', {
      functionName: 'image-service-upload',
      entry: path.join(__dirname, '../src/handlers/upload.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512, // More memory = faster execution
      environment: lambdaEnvironment,
      // Bundling configuration - uses esbuild to compile TypeScript
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
      },
      // Enable X-Ray tracing for observability
      tracing: lambda.Tracing.ACTIVE,
      // CloudWatch log retention
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // --- Analysis Lambda ---
    // Triggered by SQS, calls Bedrock for AI analysis
    const analysisLambda = new lambdaNodejs.NodejsFunction(this, 'AnalysisFunction', {
      functionName: 'image-service-analysis',
      entry: path.join(__dirname, '../src/handlers/analyze.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(120), // Longer timeout for AI processing
      memorySize: 1024, // More memory for image processing
      environment: lambdaEnvironment,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
      },
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // --- Query Lambda ---
    // Handles GET requests for images and analysis results
    const queryLambda = new lambdaNodejs.NodejsFunction(this, 'QueryFunction', {
      functionName: 'image-service-query',
      entry: path.join(__dirname, '../src/handlers/query.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: lambdaEnvironment,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
      },
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // ============================================
    // IAM PERMISSIONS
    // ============================================
    // Grant each Lambda only the permissions it needs (least privilege)
    
    // Upload Lambda needs: S3 write, DynamoDB write, SQS send
    imageBucket.grantPut(uploadLambda);
    imagesTable.grantWriteData(uploadLambda);
    imageQueue.grantSendMessages(uploadLambda);

    // Analysis Lambda needs: S3 read, DynamoDB read/write, Bedrock invoke
    imageBucket.grantRead(analysisLambda);
    imagesTable.grantReadWriteData(analysisLambda);
    analysisTable.grantWriteData(analysisLambda);
    
    // Bedrock permissions (not available as a CDK grant method, so we add manually)
    analysisLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: ['arn:aws:bedrock:*::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0'],
    }));

    // Query Lambda needs: S3 read (for presigned URLs), DynamoDB read
    imageBucket.grantRead(queryLambda);
    imagesTable.grantReadData(queryLambda);
    analysisTable.grantReadData(queryLambda);

    // ============================================
    // SQS TRIGGER - Connect Queue to Lambda
    // ============================================
    // When a message arrives in SQS, it triggers the Analysis Lambda
    
    analysisLambda.addEventSource(new lambdaEventSources.SqsEventSource(imageQueue, {
      batchSize: 1, // Process one image at a time (AI calls are expensive)
      maxConcurrency: 5, // Limit concurrent executions to control costs
    }));

    // ============================================
    // API GATEWAY - REST API
    // ============================================
    // Replaces Express routes from local setup
    // API Gateway handles routing, CORS, throttling
    
    const api = new apigateway.RestApi(this, 'ImageServiceApi', {
      restApiName: 'Image Service API',
      description: 'Serverless image upload and analysis service',
      // Enable CORS for all origins (tighten for production)
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type', 
          'Authorization',
          'X-Api-Key',
          'X-Amz-Date',
          'X-Amz-Security-Token',
          'Accept',
          'Accept-Encoding',
        ],
        allowCredentials: false,
        statusCode: 200,
      },
      // Binary media types - required for image uploads
      binaryMediaTypes: ['image/*', 'multipart/form-data'],
      // Deploy to 'prod' stage
      deployOptions: {
        stageName: 'prod',
        // Note: CloudWatch logging for API Gateway requires account-level setup
        // To enable later, set up a CloudWatch Logs role in API Gateway settings
        // loggingLevel: apigateway.MethodLoggingLevel.INFO,
        // dataTraceEnabled: true,
        // Enable X-Ray tracing (this works without account setup)
        tracingEnabled: true,
      },
    });

    // --- API Routes ---
    // Mirrors the original Express routes
    
    // /api resource
    const apiResource = api.root.addResource('api');
    
    // POST /api/upload - Upload an image
    const uploadResource = apiResource.addResource('upload');
    uploadResource.addMethod('POST', new apigateway.LambdaIntegration(uploadLambda));
    
    // /api/images - Image operations
    const imagesResource = apiResource.addResource('images');
    
    // GET /api/images - List all images
    imagesResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda));
    
    // /api/images/{imageId}
    const singleImageResource = imagesResource.addResource('{imageId}');
    
    // GET /api/images/{imageId} - Get image file
    singleImageResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda));
    
    // GET /api/images/{imageId}/info - Get image metadata
    const imageInfoResource = singleImageResource.addResource('info');
    imageInfoResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda));
    
    // /api/analysis - Analysis operations
    const analysisResource = apiResource.addResource('analysis');
    
    // GET /api/analysis - List all analysis results
    analysisResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda));
    
    // GET /api/analysis/{imageId} - Get analysis for specific image
    const singleAnalysisResource = analysisResource.addResource('{imageId}');
    singleAnalysisResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda));

    // Health check endpoint
    const healthResource = api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda));

    // ============================================
    // OUTPUTS - Display important values after deploy
    // ============================================
    
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
      exportName: 'ImageServiceApiUrl',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: imageBucket.bucketName,
      description: 'S3 Bucket for images',
      exportName: 'ImageServiceBucketName',
    });

    new cdk.CfnOutput(this, 'ImagesTableName', {
      value: imagesTable.tableName,
      description: 'DynamoDB Images table',
      exportName: 'ImageServiceImagesTable',
    });

    new cdk.CfnOutput(this, 'AnalysisTableName', {
      value: analysisTable.tableName,
      description: 'DynamoDB Analysis table',
      exportName: 'ImageServiceAnalysisTable',
    });

    new cdk.CfnOutput(this, 'QueueUrl', {
      value: imageQueue.queueUrl,
      description: 'SQS Queue URL',
      exportName: 'ImageServiceQueueUrl',
    });
  }
}
