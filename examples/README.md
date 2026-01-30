# c8ctl Examples

This directory contains comprehensive examples and tutorials for using c8ctl.

## Contents

- **[e2e-operations.ipynb](./e2e-operations.ipynb)** - Jupyter Notebook with end-to-end operation examples

## Running the Notebook

### Prerequisites

1. **Node.js v22 LTS** - Required for native TypeScript execution
   - Alternatively, use Node.js v20+ with compiled JavaScript (run `npm run build` first)
2. **Camunda 8 Cluster** - Running at `localhost:8080`
3. **Jupyter with Node.js Kernel** - Install tslab or IJavascript

### Setup

#### 1. Install Node.js Kernel for Jupyter

Choose one of the following:

**Option A: Using tslab (TypeScript/JavaScript)**
```bash
npm install -g tslab
tslab install --version
```

**Option B: Using IJavascript (JavaScript only)**
```bash
npm install -g ijavascript
ijsinstall
```

#### 2. Start Camunda 8 Locally

Using the Docker Compose files included in this repository:

```bash
# Navigate to Camunda 8.8 directory
cd assets/c8/8.8

# Start Camunda with Elasticsearch
docker compose --profile elasticsearch up -d

# Wait for Camunda to be ready
curl -u demo:demo http://localhost:8080/v2/topology
```

You should see a response indicating the cluster is healthy.

#### 3. Verify c8ctl Installation

```bash
# If installed globally
c8ctl --version

# Or run from source
cd /path/to/c8ctl
node src/index.ts --version
```

### Running the Notebook

#### Start Jupyter Notebook

```bash
cd examples
jupyter notebook e2e-operations.ipynb
```

Your browser will open with the notebook. Execute cells sequentially using Shift+Enter or the Run button.

#### Run All Cells

In Jupyter, you can run all cells at once via:
- Menu: **Cell → Run All**
- Or execute cells one by one to see detailed output

### What's Covered

The notebook demonstrates:

1. **Environment Setup** - Verify Node.js and cluster connectivity
2. **Profile Management** - Configure profiles and sessions
3. **Deployment Operations** - Deploy BPMN files and directories
4. **Process Instances** - Create, list, filter, and monitor instances
5. **User Tasks** - Work with user tasks and complete them
6. **Deploy and Run** - Combined deployment and instance creation
7. **Message Correlation** - Publish and correlate messages
8. **Incident Management** - List and resolve incidents
9. **Job Operations** - List and work with jobs
10. **Plugin System** - Load and use plugins
11. **Complete E2E Workflow** - Full journey from deployment to completion

### Troubleshooting

#### Camunda Not Running

If you see connection errors:
```bash
# Check if Camunda is running
docker ps | grep camunda

# Check logs
cd assets/c8/8.8
docker compose --profile elasticsearch logs -f
```

#### Node.js Version Issues

The notebook automatically detects your Node.js version:
- **Node.js v22+**: Uses native TypeScript execution
- **Node.js v20+**: Requires compiled JavaScript (run `npm run build` first)

```bash
node --version  # Should show v22.x.x or higher for best experience

# If using Node.js <22, compile first:
npm run build

# Use nvm to switch versions if needed
nvm use 22
```

#### Jupyter Kernel Not Found

If the JavaScript kernel is not available:
```bash
# List available kernels
jupyter kernelspec list

# Reinstall the kernel
tslab install --version
# or
ijsinstall
```

#### Permission Issues

If you encounter permission errors when executing c8ctl commands:
```bash
# Ensure you have read access to the fixtures
chmod -R +r tests/fixtures/

# Or run from the repository root
cd /path/to/c8ctl
jupyter notebook examples/e2e-operations.ipynb
```

### Testing in CI/CD

The notebook operations are also tested in GitHub Actions. See `.github/workflows/e2e-notebook.yml` for the automated test configuration.

You can also run the test script locally to validate all operations:

```bash
# Make sure Camunda is running first
cd assets/c8/8.8
docker compose --profile elasticsearch up -d
cd ../..

# Run the test script (make it executable first if needed)
chmod +x examples/test-notebook-operations.sh
./examples/test-notebook-operations.sh

# Or run directly with bash
bash examples/test-notebook-operations.sh
```

This script validates all the operations demonstrated in the notebook.

## Alternative: Bash Script Examples

If you prefer command-line examples without Jupyter, see:
- [EXAMPLES.md](../EXAMPLES.md) - Comprehensive command-line examples
- [README.md](../README.md) - Usage documentation

## Contributing

When adding new examples:
1. Ensure they work with localhost:8080
2. Use sample BPMN files from `tests/fixtures/`
3. Follow the happy path (avoid error scenarios)
4. Test in both the notebook and CI workflow
5. Update this README with new content

## Related Documentation

- [README.md](../README.md) - Main project documentation
- [EXAMPLES.md](../EXAMPLES.md) - Command-line examples
- [PLUGIN-HELP.md](../PLUGIN-HELP.md) - Plugin development guide
- [IMPLEMENTATION.md](../IMPLEMENTATION.md) - Implementation details
