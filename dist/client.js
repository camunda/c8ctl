/**
 * SDK client factory using resolved configuration
 */
import { createCamundaClient } from '@camunda8/orchestration-cluster-api';
import { resolveClusterConfig } from "./config.js";
/**
 * Create a Camunda 8 cluster client with resolved configuration
 */
export function createClient(profileFlag) {
    const config = resolveClusterConfig(profileFlag);
    // Build config object for the SDK
    const sdkConfig = {
        CAMUNDA_REST_ADDRESS: config.baseUrl,
    };
    // Add OAuth configuration if present
    if (config.clientId && config.clientSecret) {
        sdkConfig.CAMUNDA_AUTH_STRATEGY = 'OAUTH';
        sdkConfig.CAMUNDA_CLIENT_ID = config.clientId;
        sdkConfig.CAMUNDA_CLIENT_SECRET = config.clientSecret;
        if (config.audience) {
            sdkConfig.CAMUNDA_OAUTH_AUDIENCE = config.audience;
        }
        if (config.oAuthUrl) {
            sdkConfig.CAMUNDA_OAUTH_URL = config.oAuthUrl;
        }
    }
    // Add Basic auth configuration if present
    else if (config.username && config.password) {
        sdkConfig.CAMUNDA_AUTH_STRATEGY = 'BASIC';
        sdkConfig.CAMUNDA_BASIC_AUTH_USERNAME = config.username;
        sdkConfig.CAMUNDA_BASIC_AUTH_PASSWORD = config.password;
    }
    // No authentication
    else {
        sdkConfig.CAMUNDA_AUTH_STRATEGY = 'NONE';
    }
    return createCamundaClient({ config: sdkConfig });
}
//# sourceMappingURL=client.js.map