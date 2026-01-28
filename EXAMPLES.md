# c8ctl Examples

Comprehensive examples for all c8ctl operations.

## Table of Contents

- [Process Instances](#process-instances)
- [User Tasks](#user-tasks)
- [Incidents](#incidents)
- [Jobs](#jobs)
- [Messages](#messages)
- [Deployments](#deployments)
- [Topology](#topology)
- [Profile Management](#profile-management)
- [Session Management](#session-management)

---

## Process Instances

### List All Process Instances

```bash
c8 list pi
c8 list process-instances
```

### List Process Instances with Filter

```bash
# Filter by BPMN process ID
c8 list pi --bpmnProcessId=order-process

# Filter by state
c8 list pi --state=ACTIVE
```

### Get Process Instance by Key

```bash
c8 get pi 2251799813685249
c8 get process-instance 2251799813685249
```

### Create Process Instance

```bash
# Create with process ID
c8 create pi --bpmnProcessId=order-process

# Create with specific version
c8 create pi --bpmnProcessId=order-process --version_num=2

# Create with variables
c8 create pi --bpmnProcessId=order-process --variables='{"orderId":"12345","amount":100}'
```

### Cancel Process Instance

```bash
c8 cancel pi 2251799813685249
```

---

## User Tasks

### List All User Tasks

```bash
c8 list ut
c8 list user-tasks
```

### List User Tasks with Filter

```bash
# Filter by state
c8 list ut --state=CREATED

# Filter by assignee
c8 list ut --assignee=john.doe
```

### Complete User Task

```bash
# Complete without variables
c8 complete ut 2251799813685250

# Complete with variables
c8 complete ut 2251799813685250 --variables='{"approved":true,"notes":"Looks good"}'
```

---

## Incidents

### List All Incidents

```bash
c8 list inc
c8 list incidents
```

### List Incidents with Filter

```bash
# Filter by state
c8 list inc --state=ACTIVE

# Filter by process instance
c8 list inc --processInstanceKey=2251799813685249
```

### Resolve Incident

```bash
c8 resolve inc 2251799813685251
```

---

## Jobs

### List All Jobs

```bash
c8 list jobs
```

### List Jobs with Filter

```bash
# Filter by type
c8 list jobs --type=email-service

# Filter by state
c8 list jobs --state=ACTIVATABLE
```

### Activate Jobs

```bash
# Activate jobs of a specific type
c8 activate jobs email-service

# Activate with options
c8 activate jobs email-service --maxJobsToActivate=20 --timeout=120000 --worker=my-worker
```

### Complete Job

```bash
# Complete without variables
c8 complete job 2251799813685252

# Complete with variables
c8 complete job 2251799813685252 --variables='{"emailSent":true,"timestamp":"2024-01-15T10:30:00Z"}'
```

### Fail Job

```bash
# Fail job with default message
c8 fail job 2251799813685252

# Fail job with custom message and retries
c8 fail job 2251799813685252 --retries=3 --errorMessage="Email service unavailable"
```

---

## Messages

### Publish Message

```bash
# Publish simple message
c8 publish msg order-placed

# Publish with correlation key
c8 publish msg order-placed --correlationKey=order-12345

# Publish with variables
c8 publish msg order-placed --correlationKey=order-12345 --variables='{"orderId":"12345","total":250.00}'

# Publish with time-to-live
c8 publish msg order-placed --correlationKey=order-12345 --timeToLive=3600000
```

### Correlate Message

```bash
# Correlate is an alias for publish
c8 correlate msg payment-received --correlationKey=order-12345 --variables='{"amount":250.00}'
```

---

## Deployments

### Deploy Single File

```bash
c8 deploy ./process.bpmn
c8 deploy ./decision.dmn
c8 deploy ./form.form
```

### Deploy Multiple Files

```bash
c8 deploy ./process1.bpmn ./process2.bpmn ./decision.dmn
```

### Deploy Directory

```bash
# Deploy current directory
c8 deploy

# Deploys all BPMN/DMN/Form files in specified directory and subdirectories
c8 deploy ./my-project

# Building block folders (containing _bb- in name) are prioritized
# Order: _bb-* folders first, then other files
```

### Important: Duplicate Process IDs

Camunda does not allow deploying multiple resources with the same process/decision ID in a single deployment. If you have multiple BPMN files with the same process definition ID, deploy them separately:

```bash
# This will fail if both files have the same process ID
# c8 deploy process-v1.bpmn process-v2.bpmn

# Instead, deploy separately:
c8 deploy process-v1.bpmn
c8 deploy process-v2.bpmn
```

The CLI will detect duplicate IDs and provide a helpful error message showing which files conflict.

### Run (Deploy + Start)

```bash
# Deploy BPMN and create process instance
c8 run ./order-process.bpmn

# With variables
c8 run ./order-process.bpmn --variables='{"orderId":"12345","amount":100}'
```

---

## Topology

### Get Cluster Topology

```bash
c8 get topology
```

---

## Profile Management

### Add Profile

```bash
# Add profile with basic auth (localhost)
c8 add profile local --baseUrl=http://localhost:8080

# Add profile with OAuth
c8 add profile prod \
  --baseUrl=https://camunda.example.com \
  --clientId=your-client-id \
  --clientSecret=your-client-secret \
  --audience=camunda-api \
  --oAuthUrl=https://auth.example.com/oauth/token

# Add profile with default tenant
c8 add profile dev \
  --baseUrl=https://dev.camunda.example.com \
  --clientId=dev-client \
  --clientSecret=dev-secret \
  --defaultTenantId=dev-tenant
```

### List Profiles

```bash
c8 list profiles
```

### Remove Profile

```bash
c8 remove profile local
c8 rm profile local  # alias
```

---

## Session Management

### Set Active Profile

```bash
# Set profile to use for all subsequent commands
c8 use profile prod

# All commands now use 'prod' profile automatically
c8 list pi
c8 deploy ./process.bpmn
```

### Override Profile for Single Command

```bash
# Use specific profile for one command only
c8 list pi --profile=dev
c8 deploy ./process.bpmn --profile=staging
```

### Set Active Tenant

```bash
# Set tenant for all subsequent commands
c8 use tenant my-tenant-123

# All commands now include tenant filter/parameter
c8 list pi
c8 create pi --bpmnProcessId=order-process
```

### Set Output Mode

```bash
# Switch to JSON output
c8 output json

# All commands now output JSON
c8 list pi
# Output: [{"processInstanceKey":"...","bpmnProcessId":"..."}]

# Switch back to human-readable text
c8 output text
```

---

## Combined Examples

### Complete Workflow

```bash
# 1. Configure environment
c8 add profile prod --baseUrl=https://camunda.example.com --clientId=xxx --clientSecret=yyy
c8 use profile prod
c8 use tenant production

# 2. Deploy process
c8 deploy ./processes/

# 3. Create and monitor instance
c8 create pi --bpmnProcessId=order-process --variables='{"orderId":"12345"}'
# ✓ Process instance created [Key: 2251799813685249]

c8 get pi 2251799813685249

# 4. Complete user task
c8 list ut --state=CREATED
c8 complete ut 2251799813685250 --variables='{"approved":true}'

# 5. Handle incidents if any
c8 list inc --state=ACTIVE
c8 resolve inc 2251799813685251
```

### Testing Workflow

```bash
# 1. Use local environment
c8 use profile local
c8 output json  # For automated testing

# 2. Deploy and run
c8 run ./test-process.bpmn --variables='{"testData":"value"}'

# 3. Verify
c8 list pi --bpmnProcessId=test-process
```

### Multi-Tenant Management

```bash
# Deploy to multiple tenants
c8 use tenant tenant-A
c8 deploy ./shared-processes/

c8 use tenant tenant-B
c8 deploy ./shared-processes/

# List instances per tenant
c8 use tenant tenant-A
c8 list pi

c8 use tenant tenant-B
c8 list pi
```

---

## Tips

1. **Use Aliases**: Save typing with resource aliases (pi, ut, inc, msg)
2. **Profile Override**: Use `--profile` flag for one-off commands without changing session
3. **JSON Output**: Use `c8 output json` for scripting and automation
4. **Building Blocks**: Organize reusable processes in `_bb-*` folders for deployment priority
5. **Session State**: Set profile and tenant once, use everywhere
6. **Help**: Run `c8 <verb>` without resource to see available resources for that verb

---

## Environment Variables

Instead of profiles, you can use environment variables:

```bash
export CAMUNDA_BASE_URL=https://camunda.example.com
export CAMUNDA_CLIENT_ID=your-client-id
export CAMUNDA_CLIENT_SECRET=your-client-secret
export CAMUNDA_DEFAULT_TENANT_ID=my-tenant

# Now commands use these credentials
c8 list pi
```
