#!/usr/bin/env node
/**
 * AWS Image Service - CDK App Entry Point
 * 
 * This file initializes the CDK application and creates our stack.
 * The stack will be deployed to the AWS account/region configured in your CLI.
 */
import * as cdk from 'aws-cdk-lib/core';
import { AwsImageServiceStack } from '../lib/aws_image_service-stack';

const app = new cdk.App();

new AwsImageServiceStack(app, 'AwsImageServiceStack', {
  // Use the AWS account and region from your CLI configuration
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  
  // Stack description shown in AWS CloudFormation console
  description: 'Serverless image upload and AI analysis service using S3, Lambda, SQS, DynamoDB, and Bedrock',
  
  // Tags applied to all resources in the stack
  tags: {
    Project: 'ImageService',
    Environment: 'Production',
  },
});
