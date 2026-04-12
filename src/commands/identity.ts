/**
 * Identity shared helpers and assignment dispatcher
 */

import { getLogger } from '../logger.ts';
import { createClient } from '../client.ts';
import { c8ctl } from '../runtime.ts';
import { handleCommandError } from '../errors.ts';

// Re-exports
export { listUsers, searchIdentityUsers, getIdentityUser, createIdentityUser, deleteIdentityUser } from './identity-users.ts';
export { listRoles, searchIdentityRoles, getIdentityRole, createIdentityRole, deleteIdentityRole } from './identity-roles.ts';
export { listGroups, searchIdentityGroups, getIdentityGroup, createIdentityGroup, deleteIdentityGroup } from './identity-groups.ts';
export { listTenants, searchIdentityTenants, getIdentityTenant, createIdentityTenant, deleteIdentityTenant } from './identity-tenants.ts';
export { listAuthorizations, searchIdentityAuthorizations, getIdentityAuthorization, createIdentityAuthorization, deleteIdentityAuthorization } from './identity-authorizations.ts';
export { listMappingRules, searchIdentityMappingRules, getIdentityMappingRule, createIdentityMappingRule, deleteIdentityMappingRule } from './identity-mapping-rules.ts';

/**
 * Handle assign command: c8 assign <resource> <id> --to-<target>=<targetId>
 */
export async function handleAssign(resource: string, id: string, values: Record<string, unknown>, options: { profile?: string }): Promise<void> {
  const logger = getLogger();

  if (c8ctl.dryRun) {
    const targets: Record<string, unknown> = {};
    for (const key of ['to-user', 'to-group', 'to-tenant', 'to-mapping-rule']) {
      if (values[key]) targets[key] = values[key];
    }
    logger.json({ dryRun: true, command: 'assign', resource, id, targets });
    return;
  }

  const client = createClient(options.profile);

  try {
    switch (resource) {
      case 'role': {
        if (values['to-user']) {
          await client.assignRoleToUser({ roleId: id as any, username: values['to-user'] as any });
          logger.success(`Role '${id}' assigned to user '${values['to-user']}'`);
        } else if (values['to-group']) {
          await client.assignRoleToGroup({ roleId: id as any, groupId: values['to-group'] as any });
          logger.success(`Role '${id}' assigned to group '${values['to-group']}'`);
        } else if (values['to-tenant']) {
          await client.assignRoleToTenant({ tenantId: values['to-tenant'] as any, roleId: id as any });
          logger.success(`Role '${id}' assigned to tenant '${values['to-tenant']}'`);
        } else if (values['to-mapping-rule']) {
          await client.assignRoleToMappingRule({ roleId: id as any, mappingRuleId: values['to-mapping-rule'] as any });
          logger.success(`Role '${id}' assigned to mapping rule '${values['to-mapping-rule']}'`);
        } else {
          logger.error('Target required. Use --to-user, --to-group, --to-tenant, or --to-mapping-rule.');
          process.exit(1);
        }
        break;
      }
      case 'user': {
        if (values['to-group']) {
          await client.assignUserToGroup({ groupId: values['to-group'] as any, username: id as any });
          logger.success(`User '${id}' assigned to group '${values['to-group']}'`);
        } else if (values['to-tenant']) {
          await client.assignUserToTenant({ tenantId: values['to-tenant'] as any, username: id as any });
          logger.success(`User '${id}' assigned to tenant '${values['to-tenant']}'`);
        } else {
          logger.error('Target required. Use --to-group or --to-tenant.');
          process.exit(1);
        }
        break;
      }
      case 'group': {
        if (values['to-tenant']) {
          await client.assignGroupToTenant({ tenantId: values['to-tenant'] as any, groupId: id as any });
          logger.success(`Group '${id}' assigned to tenant '${values['to-tenant']}'`);
        } else {
          logger.error('Target required. Use --to-tenant.');
          process.exit(1);
        }
        break;
      }
      case 'mapping-rule': {
        if (values['to-group']) {
          await client.assignMappingRuleToGroup({ groupId: values['to-group'] as any, mappingRuleId: id as any });
          logger.success(`Mapping rule '${id}' assigned to group '${values['to-group']}'`);
        } else if (values['to-tenant']) {
          await client.assignMappingRuleToTenant({ tenantId: values['to-tenant'] as any, mappingRuleId: id as any });
          logger.success(`Mapping rule '${id}' assigned to tenant '${values['to-tenant']}'`);
        } else {
          logger.error('Target required. Use --to-group or --to-tenant.');
          process.exit(1);
        }
        break;
      }
      default:
        logger.error(`Cannot assign resource type: ${resource}. Supported: role, user, group, mapping-rule.`);
        process.exit(1);
    }
  } catch (error) {
    handleCommandError(logger, `Failed to assign ${resource}`, error);
  }
}

/**
 * Handle unassign command: c8 unassign <resource> <id> --from-<target>=<targetId>
 */
export async function handleUnassign(resource: string, id: string, values: Record<string, unknown>, options: { profile?: string }): Promise<void> {
  const logger = getLogger();

  if (c8ctl.dryRun) {
    const targets: Record<string, unknown> = {};
    for (const key of ['from-user', 'from-group', 'from-tenant', 'from-mapping-rule']) {
      if (values[key]) targets[key] = values[key];
    }
    logger.json({ dryRun: true, command: 'unassign', resource, id, targets });
    return;
  }

  const client = createClient(options.profile);

  try {
    switch (resource) {
      case 'role': {
        if (values['from-user']) {
          await client.unassignRoleFromUser({ roleId: id as any, username: values['from-user'] as any });
          logger.success(`Role '${id}' unassigned from user '${values['from-user']}'`);
        } else if (values['from-group']) {
          await client.unassignRoleFromGroup({ roleId: id as any, groupId: values['from-group'] as any });
          logger.success(`Role '${id}' unassigned from group '${values['from-group']}'`);
        } else if (values['from-tenant']) {
          await client.unassignRoleFromTenant({ tenantId: values['from-tenant'] as any, roleId: id as any });
          logger.success(`Role '${id}' unassigned from tenant '${values['from-tenant']}'`);
        } else if (values['from-mapping-rule']) {
          await client.unassignRoleFromMappingRule({ roleId: id as any, mappingRuleId: values['from-mapping-rule'] as any });
          logger.success(`Role '${id}' unassigned from mapping rule '${values['from-mapping-rule']}'`);
        } else {
          logger.error('Target required. Use --from-user, --from-group, --from-tenant, or --from-mapping-rule.');
          process.exit(1);
        }
        break;
      }
      case 'user': {
        if (values['from-group']) {
          await client.unassignUserFromGroup({ groupId: values['from-group'] as any, username: id as any });
          logger.success(`User '${id}' unassigned from group '${values['from-group']}'`);
        } else if (values['from-tenant']) {
          await client.unassignUserFromTenant({ tenantId: values['from-tenant'] as any, username: id as any });
          logger.success(`User '${id}' unassigned from tenant '${values['from-tenant']}'`);
        } else {
          logger.error('Target required. Use --from-group or --from-tenant.');
          process.exit(1);
        }
        break;
      }
      case 'group': {
        if (values['from-tenant']) {
          await client.unassignGroupFromTenant({ tenantId: values['from-tenant'] as any, groupId: id as any });
          logger.success(`Group '${id}' unassigned from tenant '${values['from-tenant']}'`);
        } else {
          logger.error('Target required. Use --from-tenant.');
          process.exit(1);
        }
        break;
      }
      case 'mapping-rule': {
        if (values['from-group']) {
          await client.unassignMappingRuleFromGroup({ groupId: values['from-group'] as any, mappingRuleId: id as any });
          logger.success(`Mapping rule '${id}' unassigned from group '${values['from-group']}'`);
        } else if (values['from-tenant']) {
          await client.unassignMappingRuleFromTenant({ tenantId: values['from-tenant'] as any, mappingRuleId: id as any });
          logger.success(`Mapping rule '${id}' unassigned from tenant '${values['from-tenant']}'`);
        } else {
          logger.error('Target required. Use --from-group or --from-tenant.');
          process.exit(1);
        }
        break;
      }
      default:
        logger.error(`Cannot unassign resource type: ${resource}. Supported: role, user, group, mapping-rule.`);
        process.exit(1);
    }
  } catch (error) {
    handleCommandError(logger, `Failed to unassign ${resource}`, error);
  }
}
