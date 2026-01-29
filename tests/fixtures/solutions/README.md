# Solution Management Plugin

This sample plugin demonstrates solution management capabilities for c8ctl.

## Commands

### `c8 solution init`
Initializes a new solution by running `npm init -y` and setting the module type to ESM.

**Usage:**
```bash
c8 solution init
```

**What it does:**
- Runs `npm init -y` to create package.json
- Sets `"type": "module"` in package.json
- Provides feedback on initialization status

---

### `c8 list-building-blocks`
Lists all available building blocks grouped by prefix.

**Usage:**
```bash
c8 list-building-blocks
```

**Available prefixes:**
- `BizSol_bb-*` - Business Solution building blocks
- `CS_bb-*` - Customer Service building blocks  
- `EMEA_bb-*` - EMEA region building blocks

**Sample output:**
```
Available building blocks:

BizSol Building Blocks:
  - BizSol_bb-customer-onboarding
  - BizSol_bb-invoice-processing
  - BizSol_bb-order-fulfillment

CS Building Blocks:
  - CS_bb-ticket-management
  - CS_bb-escalation-handling
  - CS_bb-feedback-collection

EMEA Building Blocks:
  - EMEA_bb-compliance-check
  - EMEA_bb-regional-approval
  - EMEA_bb-data-protection

Total: 9 building blocks available
```

---

### `c8 solution add building-block <block-name>`
Adds a building block to the current solution by creating a folder with the building block name.

**Usage:**
```bash
c8 solution add building-block BizSol_bb-customer-onboarding
```

**Arguments:**
- `<block-name>` - Name of the building block to add (must be from the available list)

**What it does:**
- Validates the building block name exists
- Creates a folder with the building block name
- Provides feedback on success or failure

**Example workflow:**
```bash
# Initialize a new solution
mkdir my-solution && cd my-solution
c8 solution init

# See available building blocks
c8 list-building-blocks

# Add a building block
c8 solution add building-block BizSol_bb-customer-onboarding

# Add another
c8 solution add building-block CS_bb-ticket-management
```

## Building Blocks

The plugin includes the following stub building blocks:

### Business Solution (BizSol)
- `BizSol_bb-customer-onboarding` - Customer onboarding process
- `BizSol_bb-invoice-processing` - Invoice processing automation
- `BizSol_bb-order-fulfillment` - Order fulfillment workflow

### Customer Service (CS)
- `CS_bb-ticket-management` - Support ticket management
- `CS_bb-escalation-handling` - Escalation workflows
- `CS_bb-feedback-collection` - Customer feedback collection

### EMEA Region (EMEA)
- `EMEA_bb-compliance-check` - Regulatory compliance checks
- `EMEA_bb-regional-approval` - Regional approval processes
- `EMEA_bb-data-protection` - GDPR and data protection workflows

## Implementation Notes

This is a stub/sample plugin for testing purposes. In a production implementation:

- `solution init` would set up more comprehensive project structure
- `list building-blocks` would fetch from a remote repository or registry
- `solution add building-block` would clone/download actual building block content

The plugin demonstrates:
- Multi-word commands with spaces
- Command argument handling and validation
- Async operations (npm commands, file system operations)
- Error handling and user feedback
- Grouping and formatting output
