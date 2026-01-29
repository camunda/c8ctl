/**
 * Sample c8ctl plugin for solution management
 * Demonstrates solution initialization, building block listing, and adding building blocks
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

// Stub building blocks with different prefixes
const BUILDING_BLOCKS = [
  'BizSol_bb-customer-onboarding',
  'BizSol_bb-invoice-processing',
  'BizSol_bb-order-fulfillment',
  'CS_bb-ticket-management',
  'CS_bb-escalation-handling',
  'CS_bb-feedback-collection',
  'EMEA_bb-compliance-check',
  'EMEA_bb-regional-approval',
  'EMEA_bb-data-protection',
];

export const commands = {
  /**
   * Solution management command
   * Handles: solution init, solution add building-block <name>
   */
  solution: async (args) => {
    const [subcommand, ...rest] = args;
    
    if (!subcommand) {
      console.error('Error: Subcommand required');
      console.log('Usage:');
      console.log('  c8 solution init                           Initialize a new solution');
      console.log('  c8 solution add building-block <name>     Add a building block');
      process.exit(1);
    }
    
    if (subcommand === 'init') {
      console.log('Initializing solution...');
      console.log('✓ Solution initialized successfully');
      return;
    }
    
    if (subcommand === 'add' && rest[0] === 'building-block') {
      const blockName = rest[1];
      
      if (!blockName) {
        console.error('Error: Building block name is required');
        console.log('Usage: c8 solution add building-block <block-name>');
        console.log('\nAvailable building blocks:');
        BUILDING_BLOCKS.forEach(block => console.log(`  - ${block}`));
        process.exit(1);
      }
      
      // Validate building block exists
      if (!BUILDING_BLOCKS.includes(blockName)) {
        console.error(`Error: Unknown building block '${blockName}'`);
        console.log('\nAvailable building blocks:');
        BUILDING_BLOCKS.forEach(block => console.log(`  - ${block}`));
        process.exit(1);
      }
      
      console.log(`Adding building block: ${blockName}`);
      
      try {
        // Create folder with the building block name
        const blockPath = path.join(process.cwd(), blockName);
        await fs.mkdir(blockPath, { recursive: true });
        
        console.log(`✓ Created folder: ${blockName}`);
        console.log(`✓ Building block '${blockName}' added successfully`);
      } catch (error) {
        console.error('Failed to add building block:', error);
        process.exit(1);
      }
      return;
    }
    
    console.error(`Error: Unknown subcommand '${subcommand}'`);
    console.log('Usage:');
    console.log('  c8 solution init                           Initialize a new solution');
    console.log('  c8 solution add building-block <name>     Add a building block');
    process.exit(1);
  },

  /**
   * List building blocks
   */
  'list-building-blocks': async (args) => {
    console.log('Available building blocks:\n');
    
    // Group by prefix
    const grouped = BUILDING_BLOCKS.reduce((acc, block) => {
      const prefix = block.split('_')[0];
      if (!acc[prefix]) {
        acc[prefix] = [];
      }
      acc[prefix].push(block);
      return acc;
    }, {});
    
    // Display grouped building blocks
    Object.entries(grouped).forEach(([prefix, blocks]) => {
      console.log(`${prefix} Building Blocks:`);
      blocks.forEach(block => {
        console.log(`  - ${block}`);
      });
      console.log('');
    });
    
    console.log(`Total: ${BUILDING_BLOCKS.length} building blocks available`);
  },
};
