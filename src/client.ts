/**
 * SDK client factory using resolved configuration
 */

import { createCamundaClient, type CamundaClient } from '@camunda8/orchestration-cluster-api';
import { resolveClusterConfig } from './config.ts';

/**
 * Create a Camunda 8 cluster client with resolved configuration
 */
export function createClient(profileFlag?: string): CamundaClient {
  const config = resolveClusterConfig(profileFlag);
  
  // Build options for the SDK
  const options: any = {
    baseURL: config.baseUrl,
  };

  // Add OAuth configuration if present
  if (config.clientId && config.clientSecret) {
    options.oauth = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      audience: config.audience,
      oAuthURL: config.oAuthUrl,
    };
  }

  return createCamundaClient(options);
}
