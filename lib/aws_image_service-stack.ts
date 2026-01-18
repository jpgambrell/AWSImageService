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
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
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
    // COGNITO - User Authentication
    // ============================================
    // Provides JWT-based authentication for web and mobile clients
    // Manages user sign-up, sign-in, and token refresh

    // User Pool - manages users and authentication
    const userPool = new cognito.UserPool(this, 'ImageServiceUserPool', {
      userPoolName: 'image-service-users',
      // Self-service sign up enabled
      selfSignUpEnabled: true,
      // Email-based sign in
      signInAliases: {
        email: true,
        username: false,
      },
      // Auto-verify email addresses
      autoVerify: {
        email: true,
      },
      // Standard attributes required during sign-up
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        givenName: {
          required: true,
          mutable: true,
        },
        familyName: {
          required: true,
          mutable: true,
        },
      },
      // Custom attributes
      customAttributes: {
        role: new cognito.StringAttribute({
          mutable: true,
        }),
      },
      // Password policy
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      // Account recovery via email
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // Allow deletion for dev/testing
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // User Pool Client - for web/mobile apps (public client, no secret)
    const userPoolClient = new cognito.UserPoolClient(this, 'ImageServiceUserPoolClient', {
      userPool,
      userPoolClientName: 'image-service-web-client',
      // Auth flows for web/mobile
      authFlows: {
        userPassword: true,        // Direct username/password auth
        userSrp: true,             // Secure Remote Password protocol
        custom: false,
        adminUserPassword: false,
      },
      // Token validity periods
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      // Prevent user existence errors (security best practice)
      preventUserExistenceErrors: true,
      // Enable token revocation
      enableTokenRevocation: true,
      // No client secret for public clients (web/mobile apps)
      generateSecret: false,
    });

    // User Pool Groups for role-based access control
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'admin',
      description: 'Administrators with access to all user data',
      precedence: 0, // Higher priority (lower number)
    });

    const userGroup = new cognito.CfnUserPoolGroup(this, 'UserGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'user',
      description: 'Regular users with access only to their own data',
      precedence: 1,
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

    // Add Global Secondary Index for listing images by user
    imagesTable.addGlobalSecondaryIndex({
      indexName: 'userId-uploadedAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
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

    // Add GSI for listing analysis by user
    analysisTable.addGlobalSecondaryIndex({
      indexName: 'userId-analyzedAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
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
      // Cognito configuration
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
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

    // --- Auth Lambda ---
    // Handles authentication endpoints: signup, signin, refresh, password reset
    const authLambda = new lambdaNodejs.NodejsFunction(this, 'AuthFunction', {
      functionName: 'image-service-auth',
      entry: path.join(__dirname, '../src/handlers/auth.ts'),
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

    // Auth Lambda needs: Cognito permissions
    authLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:SignUp',
        'cognito-idp:InitiateAuth',
        'cognito-idp:RespondToAuthChallenge',
        'cognito-idp:ForgotPassword',
        'cognito-idp:ConfirmForgotPassword',
        'cognito-idp:ConfirmSignUp',
        'cognito-idp:GetUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:ListUsers',
      ],
      resources: [userPool.userPoolArn],
    }));

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

    // Cognito Authorizer for protected routes
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'ImageServiceAuthorizer',
      identitySource: 'method.request.header.Authorization',
    });

    // Method options for protected routes (requires JWT token)
    const protectedMethodOptions: apigateway.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // --- API Routes ---
    // Mirrors the original Express routes

    // /api resource
    const apiResource = api.root.addResource('api');

    // POST /api/upload - Upload an image (PROTECTED)
    const uploadResource = apiResource.addResource('upload');
    uploadResource.addMethod('POST', new apigateway.LambdaIntegration(uploadLambda), protectedMethodOptions);

    // /api/images - Image operations
    const imagesResource = apiResource.addResource('images');

    // GET /api/images - List all images (PROTECTED)
    imagesResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda), protectedMethodOptions);

    // /api/images/{imageId}
    const singleImageResource = imagesResource.addResource('{imageId}');

    // GET /api/images/{imageId} - Get image file (PROTECTED)
    singleImageResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda), protectedMethodOptions);

    // GET /api/images/{imageId}/info - Get image metadata (PROTECTED)
    const imageInfoResource = singleImageResource.addResource('info');
    imageInfoResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda), protectedMethodOptions);

    // /api/analysis - Analysis operations
    const analysisResource = apiResource.addResource('analysis');

    // GET /api/analysis - List all analysis results (PROTECTED)
    analysisResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda), protectedMethodOptions);

    // GET /api/analysis/{imageId} - Get analysis for specific image (PROTECTED)
    const singleAnalysisResource = analysisResource.addResource('{imageId}');
    singleAnalysisResource.addMethod('GET', new apigateway.LambdaIntegration(queryLambda), protectedMethodOptions);

    // /api/auth - Authentication endpoints (PUBLIC)
    const authResource = apiResource.addResource('auth');

    // POST /api/auth/signup - Register new user
    const signupResource = authResource.addResource('signup');
    signupResource.addMethod('POST', new apigateway.LambdaIntegration(authLambda));

    // POST /api/auth/signin - Authenticate user
    const signinResource = authResource.addResource('signin');
    signinResource.addMethod('POST', new apigateway.LambdaIntegration(authLambda));

    // POST /api/auth/confirm - Confirm user registration
    const confirmResource = authResource.addResource('confirm');
    confirmResource.addMethod('POST', new apigateway.LambdaIntegration(authLambda));

    // POST /api/auth/refresh - Refresh access token
    const refreshResource = authResource.addResource('refresh');
    refreshResource.addMethod('POST', new apigateway.LambdaIntegration(authLambda));

    // POST /api/auth/forgot-password - Initiate password reset
    const forgotPasswordResource = authResource.addResource('forgot-password');
    forgotPasswordResource.addMethod('POST', new apigateway.LambdaIntegration(authLambda));

    // POST /api/auth/confirm-forgot-password - Complete password reset
    const confirmForgotPasswordResource = authResource.addResource('confirm-forgot-password');
    confirmForgotPasswordResource.addMethod('POST', new apigateway.LambdaIntegration(authLambda));

    // GET /api/auth/me - Get current user profile (PROTECTED)
    const meResource = authResource.addResource('me');
    meResource.addMethod('GET', new apigateway.LambdaIntegration(authLambda), protectedMethodOptions);

    // Health check endpoint (PUBLIC)
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

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: 'ImageServiceUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: 'ImageServiceUserPoolClientId',
    });

    // ============================================
    // BUDGET MONITORING - Track Bedrock Costs
    // ============================================
    // Monitors Amazon Bedrock spending and sends alerts when thresholds are reached

    const bedrockBudget = new budgets.CfnBudget(this, 'BedrockBudget', {
      budget: {
        budgetName: 'BedrockMonthlyBudget',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: 50, // $50/month
          unit: 'USD',
        },
        // Filter to track only Amazon Bedrock costs
        costFilters: {
          Service: ['Amazon Bedrock'],
        },
      },
      // Set up notifications at different threshold levels
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80, // Alert at 80% of budget ($40)
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: 'john.gambrell@gmail.com',
            },
          ],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100, // Alert when budget is exceeded
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: 'john.gambrell@gmail.com',
            },
          ],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100, // Alert if forecasted to exceed budget
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: 'john.gambrell@gmail.com',
            },
          ],
        },
      ],
    });

    new cdk.CfnOutput(this, 'BedrockBudgetName', {
      value: 'BedrockMonthlyBudget',
      description: 'Budget name for Bedrock cost monitoring',
      exportName: 'BedrockBudgetName',
    });

    // ============================================
    // IAM PERMISSIONS - Grant Cost & Budget Access
    // ============================================
    // Create a custom policy for budget and cost access
    // Note: This policy needs to be manually attached to the jpg-developer user

    const budgetAndCostPolicy = new iam.ManagedPolicy(this, 'BudgetAndCostViewPolicy', {
      managedPolicyName: 'ImageService-BudgetAndCostView',
      description: 'Allows viewing AWS Budgets, Cost Explorer, and billing information',
      statements: [
        // Budgets permissions
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'budgets:ViewBudget',
            'budgets:DescribeBudgets',
            'budgets:DescribeBudgetActionsForBudget',
            'budgets:DescribeBudgetActionHistories',
            'budgets:DescribeBudgetActionsForAccount',
            'budgets:DescribeBudgetPerformanceHistory',
          ],
          resources: ['*'],
        }),
        // Cost Explorer permissions
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'ce:GetCostAndUsage',
            'ce:GetCostForecast',
            'ce:GetDimensionValues',
            'ce:GetReservationUtilization',
            'ce:GetTags',
            'ce:GetCostCategories',
          ],
          resources: ['*'],
        }),
        // Billing permissions
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'aws-portal:ViewBilling',
            'aws-portal:ViewUsage',
            'cur:DescribeReportDefinitions',
          ],
          resources: ['*'],
        }),
      ],
    });

    new cdk.CfnOutput(this, 'CostPolicyArn', {
      value: budgetAndCostPolicy.managedPolicyArn,
      description: 'ARN of the Budget and Cost viewing policy - attach to jpg-developer user',
      exportName: 'BudgetAndCostViewPolicyArn',
    });

    // ============================================
    // CLOUDWATCH DASHBOARD - Centralized Monitoring
    // ============================================
    // Creates a unified view of all service metrics in one dashboard

    const dashboard = new cloudwatch.Dashboard(this, 'ImageServiceDashboard', {
      dashboardName: 'ImageService-MainDashboard',
    });

    // --- Lambda Function Metrics ---
    // Track invocations, errors, duration, and throttles for all Lambda functions

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        width: 12,
        height: 6,
        left: [
          uploadLambda.metricInvocations({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          analysisLambda.metricInvocations({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          queryLambda.metricInvocations({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          authLambda.metricInvocations({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
        legendPosition: cloudwatch.LegendPosition.RIGHT,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        width: 12,
        height: 6,
        left: [
          uploadLambda.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.RED }),
          analysisLambda.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.ORANGE }),
          queryLambda.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.PURPLE }),
          authLambda.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.PINK }),
        ],
        legendPosition: cloudwatch.LegendPosition.RIGHT,
      })
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration (ms)',
        width: 12,
        height: 6,
        left: [
          uploadLambda.metricDuration({ statistic: 'Average', period: cdk.Duration.minutes(5) }),
          analysisLambda.metricDuration({ statistic: 'Average', period: cdk.Duration.minutes(5) }),
          queryLambda.metricDuration({ statistic: 'Average', period: cdk.Duration.minutes(5) }),
          authLambda.metricDuration({ statistic: 'Average', period: cdk.Duration.minutes(5) }),
        ],
        legendPosition: cloudwatch.LegendPosition.RIGHT,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Throttles',
        width: 12,
        height: 6,
        left: [
          uploadLambda.metricThrottles({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.RED }),
          analysisLambda.metricThrottles({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.ORANGE }),
          queryLambda.metricThrottles({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.PURPLE }),
          authLambda.metricThrottles({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.PINK }),
        ],
        legendPosition: cloudwatch.LegendPosition.RIGHT,
      })
    );

    // --- API Gateway Metrics ---
    // Monitor API requests, latency, and errors

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Gateway Requests',
        width: 8,
        height: 6,
        left: [
          api.metricCount({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway 4XX Errors',
        width: 8,
        height: 6,
        left: [
          api.metricClientError({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.ORANGE }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway 5XX Errors',
        width: 8,
        height: 6,
        left: [
          api.metricServerError({ statistic: 'Sum', period: cdk.Duration.minutes(5), color: cloudwatch.Color.RED }),
        ],
      })
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Gateway Latency',
        width: 24,
        height: 6,
        left: [
          api.metricLatency({ statistic: 'Average', period: cdk.Duration.minutes(5), label: 'Average' }),
          api.metricLatency({ statistic: 'p99', period: cdk.Duration.minutes(5), label: 'p99', color: cloudwatch.Color.ORANGE }),
        ],
        legendPosition: cloudwatch.LegendPosition.RIGHT,
      })
    );

    // --- SQS Queue Metrics ---
    // Track message flow through the processing queue

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SQS Messages Sent',
        width: 8,
        height: 6,
        left: [
          imageQueue.metricNumberOfMessagesSent({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'SQS Messages Visible (Queue Depth)',
        width: 8,
        height: 6,
        left: [
          imageQueue.metricApproximateNumberOfMessagesVisible({ statistic: 'Average', period: cdk.Duration.minutes(5) }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'SQS Messages in Dead Letter Queue',
        width: 8,
        height: 6,
        left: [
          deadLetterQueue.metricApproximateNumberOfMessagesVisible({ statistic: 'Average', period: cdk.Duration.minutes(5), color: cloudwatch.Color.RED }),
        ],
      })
    );

    // --- DynamoDB Metrics ---
    // Monitor database read/write operations and throttles

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Read Capacity (Images)',
        width: 12,
        height: 6,
        left: [
          imagesTable.metricConsumedReadCapacityUnits({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Write Capacity (Images)',
        width: 12,
        height: 6,
        left: [
          imagesTable.metricConsumedWriteCapacityUnits({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
      })
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Read Capacity (Analysis)',
        width: 12,
        height: 6,
        left: [
          analysisTable.metricConsumedReadCapacityUnits({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Write Capacity (Analysis)',
        width: 12,
        height: 6,
        left: [
          analysisTable.metricConsumedWriteCapacityUnits({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
      })
    );

    // --- S3 Bucket Metrics ---
    // Track storage operations

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'S3 Bucket Operations',
        width: 24,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/S3',
            metricName: 'NumberOfObjects',
            dimensionsMap: {
              BucketName: imageBucket.bucketName,
              StorageType: 'AllStorageTypes',
            },
            statistic: 'Average',
            period: cdk.Duration.hours(1),
            label: 'Number of Objects',
          }),
        ],
        leftYAxis: {
          label: 'Count',
        },
      })
    );

    // --- Summary Metrics ---
    // High-level KPIs displayed as single-value widgets

    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Total API Requests (24h)',
        width: 6,
        height: 3,
        metrics: [
          api.metricCount({ statistic: 'Sum', period: cdk.Duration.hours(24) }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Total Lambda Invocations (24h)',
        width: 6,
        height: 3,
        metrics: [
          uploadLambda.metricInvocations({ statistic: 'Sum', period: cdk.Duration.hours(24) }),
          analysisLambda.metricInvocations({ statistic: 'Sum', period: cdk.Duration.hours(24) }),
          queryLambda.metricInvocations({ statistic: 'Sum', period: cdk.Duration.hours(24) }),
          authLambda.metricInvocations({ statistic: 'Sum', period: cdk.Duration.hours(24) }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Total Errors (24h)',
        width: 6,
        height: 3,
        metrics: [
          uploadLambda.metricErrors({ statistic: 'Sum', period: cdk.Duration.hours(24) }),
          analysisLambda.metricErrors({ statistic: 'Sum', period: cdk.Duration.hours(24) }),
          queryLambda.metricErrors({ statistic: 'Sum', period: cdk.Duration.hours(24) }),
          authLambda.metricErrors({ statistic: 'Sum', period: cdk.Duration.hours(24) }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Messages in DLQ',
        width: 6,
        height: 3,
        metrics: [
          deadLetterQueue.metricApproximateNumberOfMessagesVisible({ statistic: 'Maximum', period: cdk.Duration.hours(1) }),
        ],
      })
    );

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
      description: 'CloudWatch Dashboard URL for monitoring',
      exportName: 'ImageServiceDashboardUrl',
    });
  }
}
