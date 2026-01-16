# AWS Image Service

A serverless image upload and AI analysis service built with AWS CDK, Lambda, S3, SQS, DynamoDB, and Amazon Bedrock.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   API Gateway   │────>│  Upload Lambda  │────>│   S3 Bucket     │
│   (REST API)    │     │                 │     │   (Images)      │
└────────┬────────┘     └────────┬────────┘     └─────────────────┘
         │                       │
         │                       │
         │                       ▼
         │              ┌─────────────────┐     ┌─────────────────┐
         │              │   SQS Queue     │────>│ Analysis Lambda │
         │              │                 │     │ (Bedrock AI)    │
         │              └─────────────────┘     └────────┬────────┘
         │                                               │
         │                                               │
         ▼                                               ▼
┌─────────────────┐                            ┌─────────────────┐
│  Query Lambda   │<───────────────────────────│    DynamoDB     │
│                 │                            │  (Metadata +    │
└─────────────────┘                            │   Analysis)     │
                                               └─────────────────┘
```

## Features

- **Image Upload**: REST API for uploading images (JPEG, PNG, GIF, WebP, max 10MB)
- **AI Analysis**: Amazon Bedrock Claude 3 Sonnet for image analysis
  - Natural language descriptions
  - Keyword extraction
  - Text detection (OCR for addresses, signs, etc.)
- **Serverless**: Pay only for what you use, auto-scaling
- **Observability**: CloudWatch Logs + X-Ray tracing

## Comparison: Local vs AWS

| Component | Local (Docker) | AWS (Serverless) |
|-----------|---------------|------------------|
| Upload API | Express.js | API Gateway + Lambda |
| Analysis | Kafka Consumer | SQS + Lambda |
| AI Model | Ollama/LLaVA | Bedrock Claude 3 |
| Storage | Shared Volume | S3 |
| Database | PostgreSQL | DynamoDB |
| Logs | Loki/Grafana | CloudWatch |

## Prerequisites

- AWS CLI configured (`aws configure`)
- Node.js 20+
- AWS CDK CLI (`npm install -g aws-cdk`)
- AWS account with Bedrock model access enabled

### Enable Bedrock Model Access

1. Go to AWS Console → Amazon Bedrock → Model access
2. Request access to **Claude 3 Sonnet** (anthropic.claude-3-sonnet-20240229-v1:0)
3. Wait for access to be granted (usually instant)

## Quick Start

### 1. Install Dependencies

```bash
cd /path/to/AWSImageService
npm install
```

### 2. Bootstrap CDK (First Time Only)

CDK needs to create some resources in your AWS account to manage deployments:

```bash
cdk bootstrap
```

### 3. Deploy the Stack

```bash
# See what will be created
cdk diff

# Deploy to AWS
cdk deploy
```

After deployment, you'll see outputs like:
```
Outputs:
AwsImageServiceStack.ApiUrl = https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/
AwsImageServiceStack.BucketName = image-service-bucket-123456789012-us-east-1
```

### 4. Test the API

```bash
# Set your API URL
export API_URL=https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod

# Health check
curl $API_URL/health

# Upload an image
curl -X POST $API_URL/api/upload \
  -F "image=@/path/to/your/image.jpg"

# List images
curl $API_URL/api/images

# Get analysis results
curl $API_URL/api/analysis
```

## API Reference

### Upload Image
```
POST /api/upload
Content-Type: multipart/form-data

Form field: image (file)
```

Response:
```json
{
  "success": true,
  "message": "Image uploaded successfully",
  "data": {
    "id": "uuid-here",
    "filename": "uuid.jpg",
    "originalName": "photo.jpg",
    "mimetype": "image/jpeg",
    "size": 123456,
    "uploadedAt": "2024-01-01T00:00:00.000Z",
    "path": "/api/images/uuid-here"
  }
}
```

### List Images
```
GET /api/images
```

### Get Image
```
GET /api/images/{imageId}
```
Returns: 302 redirect to presigned S3 URL

### Get Image Metadata
```
GET /api/images/{imageId}/info
```

### List Analysis Results
```
GET /api/analysis
```

### Get Analysis Result
```
GET /api/analysis/{imageId}
```

Response:
```json
{
  "success": true,
  "data": {
    "imageId": "uuid-here",
    "filename": "uuid.jpg",
    "description": "A scenic mountain landscape at sunset...",
    "keywords": ["mountain", "sunset", "landscape", "nature", "sky"],
    "detectedText": ["Welcome to National Park", "Visitor Center"],
    "status": "completed",
    "analyzedAt": "2024-01-01T00:00:05.000Z"
  }
}
```

### Health Check
```
GET /health
```

## Project Structure

```
AWSImageService/
├── bin/
│   └── aws_image_service.ts    # CDK app entry point
├── lib/
│   └── aws_image_service-stack.ts  # Infrastructure definition
├── src/
│   ├── handlers/
│   │   ├── upload.ts           # Upload Lambda
│   │   ├── analyze.ts          # Analysis Lambda (Bedrock)
│   │   └── query.ts            # Query Lambda
│   └── types/
│       └── index.ts            # Shared TypeScript types
├── cdk.json                    # CDK configuration
├── package.json
└── tsconfig.json
```

## Cost Estimation

**At low volume (100 images/month):**
| Service | Cost |
|---------|------|
| API Gateway | ~$0.01 |
| Lambda | ~$0.00 (free tier) |
| S3 | ~$0.03 |
| SQS | ~$0.00 (free tier) |
| DynamoDB | ~$0.00 (free tier) |
| Bedrock (Claude) | ~$0.30-1.00 |
| **Total** | **~$1-2/month** |

**At scale (10,000 images/month):**
- Total: ~$45-115/month (scales linearly)

## Useful Commands

```bash
# Compile TypeScript
npm run build

# Watch for changes
npm run watch

# Run tests
npm test

# Preview CloudFormation template
cdk synth

# Show what will change
cdk diff

# Deploy stack
cdk deploy

# Destroy stack (removes all resources)
cdk destroy
```

## Monitoring

### CloudWatch Logs

Each Lambda has its own log group:
- `/aws/lambda/image-service-upload`
- `/aws/lambda/image-service-analysis`
- `/aws/lambda/image-service-query`

View logs in AWS Console or via CLI:
```bash
aws logs tail /aws/lambda/image-service-upload --follow
```

### X-Ray Tracing

Traces are enabled for all Lambdas. View in AWS Console → X-Ray → Traces.

## Troubleshooting

### "Access Denied" on Bedrock

1. Check model access is enabled in Bedrock console
2. Verify your AWS region supports Claude 3 Sonnet
3. Check Lambda execution role has `bedrock:InvokeModel` permission

### Upload fails with "Invalid file type"

Supported types: JPEG, PNG, GIF, WebP. Check the file's MIME type.

### Analysis stuck on "processing"

1. Check the Analysis Lambda logs in CloudWatch
2. Verify the SQS message was delivered
3. Check for errors in the Dead Letter Queue

## Clean Up

To remove all AWS resources:

```bash
cdk destroy
```

This will delete:
- S3 bucket and all images
- DynamoDB tables and data
- SQS queues
- Lambda functions
- API Gateway
- IAM roles

## License

ISC
