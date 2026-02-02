#!/usr/bin/env node
/**
 * Verify c8ctl-mcp-chat plugin structure
 * This script checks that the plugin meets c8ctl requirements
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔍 Verifying c8ctl-mcp-chat plugin structure...\n');

// Check 1: package.json exists and has required fields
console.log('✓ Checking package.json...');
const packageJsonPath = join(__dirname, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

const requiredFields = ['name', 'version', 'keywords', 'main'];
const missingFields = requiredFields.filter(field => !packageJson[field]);
if (missingFields.length > 0) {
  console.error(`❌ Missing required fields in package.json: ${missingFields.join(', ')}`);
  process.exit(1);
}

if (!packageJson.keywords.includes('c8ctl') && !packageJson.keywords.includes('c8ctl-plugin')) {
  console.error('❌ package.json must include "c8ctl" or "c8ctl-plugin" in keywords');
  process.exit(1);
}

console.log(`  Name: ${packageJson.name}`);
console.log(`  Version: ${packageJson.version}`);
console.log(`  Main: ${packageJson.main}`);

// Check 2: c8ctl-plugin.js exists
console.log('\n✓ Checking plugin file...');
const pluginPath = join(__dirname, 'c8ctl-plugin.js');
try {
  readFileSync(pluginPath, 'utf-8');
  console.log(`  Found: ${packageJson.main}`);
} catch (error) {
  console.error(`❌ Plugin file not found: ${packageJson.main}`);
  process.exit(1);
}

// Check 3: Plugin exports commands and metadata
console.log('\n✓ Checking plugin exports...');
try {
  const plugin = await import(pluginPath);
  
  if (!plugin.commands || typeof plugin.commands !== 'object') {
    console.error('❌ Plugin must export a "commands" object');
    process.exit(1);
  }
  
  const commandNames = Object.keys(plugin.commands);
  console.log(`  Commands: ${commandNames.join(', ')}`);
  
  if (plugin.metadata) {
    console.log(`  Metadata: ${plugin.metadata.name || 'unnamed'}`);
    if (plugin.metadata.commands) {
      console.log(`  Command descriptions: ${Object.keys(plugin.metadata.commands).length}`);
    }
  } else {
    console.log('  Metadata: (optional) not provided');
  }
  
  // Check that all commands are functions
  for (const [name, fn] of Object.entries(plugin.commands)) {
    if (typeof fn !== 'function') {
      console.error(`❌ Command "${name}" must be a function`);
      process.exit(1);
    }
  }
  
} catch (error) {
  console.error(`❌ Error loading plugin: ${error.message}`);
  process.exit(1);
}

// Check 4: Dependencies are installed
console.log('\n✓ Checking dependencies...');
const requiredDeps = ['@modelcontextprotocol/sdk', 'zod'];
for (const dep of requiredDeps) {
  if (!packageJson.dependencies || !packageJson.dependencies[dep]) {
    console.warn(`⚠️  Dependency not listed in package.json: ${dep}`);
  } else {
    console.log(`  ${dep}: ${packageJson.dependencies[dep]}`);
  }
}

console.log('\n✅ Plugin structure verification passed!\n');
console.log('The plugin is correctly structured and ready to be loaded into c8ctl.');
console.log('\nTo install:');
console.log('  npm install file:./plugins/c8ctl-mcp-chat');
console.log('\nTo use:');
console.log('  c8 chat');
