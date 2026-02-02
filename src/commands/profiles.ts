/**
 * Connection management commands (Modeler-compatible)
 * Connections are stored in Camunda Modeler's config.json format
 */

import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger.ts';
import {
  loadConnections,
  saveConnection,
  removeConnection,
  getConnection,
  getConnectionLabel,
  getAuthTypeLabel,
  getTargetTypeLabel,
  validateConnection,
  TARGET_TYPES,
  AUTH_TYPES,
  type Connection,
  type TargetType,
  type AuthType,
} from '../config.ts';

/**
 * List all connections
 */
export function listProfiles(): void {
  const logger = getLogger();
  const connections = loadConnections();

  if (connections.length === 0) {
    logger.info('No connections configured');
    logger.info('');
    logger.info('Add a connection with: c8ctl profiles add <name> --url <cluster-url>');
    logger.info('Or configure connections in Camunda Modeler and they will appear here.');
    return;
  }

  interface ConnectionTableRow {
    Name: string;
    Type: string;
    URL: string;
    Auth: string;
    Tenant: string;
  }

  const tableData: ConnectionTableRow[] = connections.map(conn => {
    const url = conn.targetType === TARGET_TYPES.CAMUNDA_CLOUD
      ? conn.camundaCloudClusterUrl
      : conn.contactPoint;

    return {
      Name: getConnectionLabel(conn),
      Type: getTargetTypeLabel(conn),
      URL: url || '(not set)',
      Auth: getAuthTypeLabel(conn),
      Tenant: conn.tenantId || '<default>',
    };
  });

  logger.table(tableData);
}

/**
 * Show connection details
 */
export function showProfile(identifier: string): void {
  const logger = getLogger();
  const conn = getConnection(identifier);

  if (!conn) {
    logger.error(`Connection '${identifier}' not found`);
    process.exit(1);
  }

  logger.info(`Connection: ${getConnectionLabel(conn)}`);
  logger.info(`  ID: ${conn.id}`);
  logger.info(`  Type: ${getTargetTypeLabel(conn)}`);

  if (conn.targetType === TARGET_TYPES.CAMUNDA_CLOUD) {
    logger.info(`  Cluster URL: ${conn.camundaCloudClusterUrl || '(not set)'}`);
    logger.info(`  Client ID: ${conn.camundaCloudClientId || '(not set)'}`);
    logger.info(`  Client Secret: ${conn.camundaCloudClientSecret ? '********' : '(not set)'}`);
  } else {
    logger.info(`  Contact Point: ${conn.contactPoint || '(not set)'}`);
    logger.info(`  Auth Type: ${getAuthTypeLabel(conn)}`);

    if (conn.authType === AUTH_TYPES.BASIC) {
      logger.info(`  Username: ${conn.basicAuthUsername || '(not set)'}`);
      logger.info(`  Password: ${conn.basicAuthPassword ? '********' : '(not set)'}`);
    } else if (conn.authType === AUTH_TYPES.OAUTH) {
      logger.info(`  Client ID: ${conn.clientId || '(not set)'}`);
      logger.info(`  Client Secret: ${conn.clientSecret ? '********' : '(not set)'}`);
      logger.info(`  OAuth URL: ${conn.oauthURL || '(not set)'}`);
      logger.info(`  Audience: ${conn.audience || '(not set)'}`);
      if (conn.scope) {
        logger.info(`  Scope: ${conn.scope}`);
      }
    }

    if (conn.tenantId) {
      logger.info(`  Tenant ID: ${conn.tenantId}`);
    }
    if (conn.operateUrl) {
      logger.info(`  Operate URL: ${conn.operateUrl}`);
    }
  }
}

export interface AddConnectionOptions {
  // Common options
  url?: string;
  type?: string;
  tenantId?: string;
  operateUrl?: string;

  // Cloud options
  clientId?: string;
  clientSecret?: string;

  // Self-hosted auth options
  authType?: string;
  username?: string;
  password?: string;
  oauthUrl?: string;
  audience?: string;
  scope?: string;
}

/**
 * Add a connection
 */
export function addProfile(name: string, options: AddConnectionOptions): void {
  const logger = getLogger();

  // Determine target type
  let targetType: TargetType = TARGET_TYPES.SELF_HOSTED;
  if (options.type === 'cloud' || options.type === 'camundaCloud') {
    targetType = TARGET_TYPES.CAMUNDA_CLOUD;
  } else if (options.url?.includes('zeebe.camunda.io')) {
    targetType = TARGET_TYPES.CAMUNDA_CLOUD;
  }

  const connection: Connection = {
    id: randomUUID(),
    name,
    targetType,
  };

  if (targetType === TARGET_TYPES.CAMUNDA_CLOUD) {
    if (!options.url) {
      logger.error('Cluster URL is required. Use --url flag');
      process.exit(1);
    }
    connection.camundaCloudClusterUrl = options.url;
    connection.camundaCloudClientId = options.clientId;
    connection.camundaCloudClientSecret = options.clientSecret;
  } else {
    connection.contactPoint = options.url || 'http://localhost:8080/v2';
    connection.tenantId = options.tenantId;
    connection.operateUrl = options.operateUrl;

    // Determine auth type
    let authType: AuthType = AUTH_TYPES.NONE;
    if (options.authType === 'basic' || (options.username && options.password)) {
      authType = AUTH_TYPES.BASIC;
    } else if (options.authType === 'oauth' || (options.clientId && options.clientSecret && !options.url?.includes('zeebe.camunda.io'))) {
      authType = AUTH_TYPES.OAUTH;
    } else if (options.authType) {
      authType = options.authType as AuthType;
    }

    connection.authType = authType;

    if (authType === AUTH_TYPES.BASIC) {
      connection.basicAuthUsername = options.username;
      connection.basicAuthPassword = options.password;
    } else if (authType === AUTH_TYPES.OAUTH) {
      connection.clientId = options.clientId;
      connection.clientSecret = options.clientSecret;
      connection.oauthURL = options.oauthUrl;
      connection.audience = options.audience;
      connection.scope = options.scope;
    }
  }

  // Validate connection
  const errors = validateConnection(connection);
  if (errors.length > 0) {
    logger.error('Invalid connection configuration:');
    for (const error of errors) {
      logger.error(`  - ${error}`);
    }
    process.exit(1);
  }

  saveConnection(connection);
  logger.success(`Connection '${name}' added (ID: ${connection.id})`);
}

/**
 * Remove a connection
 */
export function removeProfile(name: string): void {
  const logger = getLogger();

  const removed = removeConnection(name);
  if (removed) {
    logger.success(`Connection '${name}' removed`);
  } else {
    logger.error(`Connection '${name}' not found`);
    process.exit(1);
  }
}
