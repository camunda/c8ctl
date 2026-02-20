#!/usr/bin/env bash
#
# E2E Smoke Test for c8ctl
# 
# Quick validation script that tests basic CLI functionality.
# This complements the comprehensive TypeScript e2e tests.
#
# Prerequisites:
# - Camunda 8 running at http://localhost:8080
# - Node.js 22 LTS
#
# Usage:
#   ./smoke-test.sh [--verbose|-v]
#
# Environment Variables:
#   C8_WAIT_TIME - Default wait time in seconds after state-changing commands (default: 1)
#                  Example: C8_WAIT_TIME=2 ./smoke-test.sh

set -euo pipefail

# Parse arguments
VERBOSE=false
while (( $# )); do
    case $1 in
        -v|--verbose)
            VERBOSE=true
            ;;
    esac
    shift
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# CLI command
C8="node src/index.ts"

# Default wait time after commands that modify state (in seconds)
C8_WAIT_TIME=${C8_WAIT_TIME:-1}

# Wrapper function for C8 commands that need time to propagate
# Usage: c8_cmd [wait_time] command args...
# If first arg is a number, use it as wait time, otherwise use default
# Use wait_time=0 for read-only commands (list, get, search) to skip waiting
c8_cmd() {
    local wait_time="$C8_WAIT_TIME"
    
    # Check if first argument is a number (custom wait time)
    if [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
        wait_time="$1"
        shift
    fi
    
    # Execute the command
    $C8 "$@"
    local exit_code=$?
    
    # Wait for state to propagate if command succeeded
    if [ $exit_code -eq 0 ] && [ "$wait_time" != "0" ]; then
        sleep "$wait_time"
    fi
    
    return $exit_code
}

echo "🚀 Starting c8ctl E2E Smoke Tests"
if [ "$VERBOSE" = true ]; then
    echo "    (verbose mode enabled)"
fi
echo "=================================="
echo ""

# Helper functions
test_start() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo -n "Test $TESTS_RUN: $1 ... "
}

test_pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo -e "${GREEN}✓ PASS${NC}"
}

test_fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo -e "${RED}✗ FAIL${NC}"
    if [ -n "${1:-}" ]; then
        echo -e "  ${RED}Error: $1${NC}"
    fi
}

# Debug output helper
debug_output() {
    if [ "$VERBOSE" = true ]; then
        echo ""
        echo -e "${YELLOW}Command output:${NC}"
        echo "$1" | sed 's/^/  /'
        echo ""
    fi
}

test_pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo -e "${GREEN}✓ PASS${NC}"
}

cleanup_session() {
    # Clean session state between tests
    local config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/c8ctl"
    if [ -f "$config_dir/session.json" ]; then
        rm -f "$config_dir/session.json"
    fi
}

# Test 1: Help command
test_start "help command works"
if OUTPUT=$(c8_cmd 0 help 2>&1); then
    debug_output "$OUTPUT"
    if echo "$OUTPUT" | grep -q "c8ctl - Camunda 8 CLI"; then
        test_pass
    else
        test_fail "help output doesn't contain 'c8ctl - Camunda 8 CLI'"
    fi
else
    test_fail "help command failed"
fi

# Test 2: Deploy a process
test_start "deploy process"
cleanup_session
if OUTPUT=$(c8_cmd deploy tests/fixtures/simple.bpmn 2>&1); then
    debug_output "$OUTPUT"
    if echo "$OUTPUT" | grep -q "Deployment successful"; then
        # Extract process definition key from the output table (last column before the end)
        PROCESS_KEY=$(echo "$OUTPUT" | grep "simple-process" | awk '{print $NF}')
        
        # List process definitions to verify deployment (wait time handled by c8_cmd)
        if LIST_PD=$(c8_cmd 0 list pd 2>&1); then
            debug_output "$LIST_PD"
            # Verify the process ID appears
            if ! echo "$LIST_PD" | grep -q "simple-process"; then
                test_fail "process ID 'simple-process' not found in list pd"
            # Verify the process definition key appears
            elif [ -n "$PROCESS_KEY" ] && ! echo "$LIST_PD" | grep -q "$PROCESS_KEY"; then
                test_fail "process key $PROCESS_KEY not found in list pd"
            else
                test_pass
            fi
        else
            test_fail "list pd command failed after deploy"
        fi
    else
        test_fail "deploy succeeded but no success message"
    fi
else
    test_fail "deploy command failed"
fi

# Test 3: Create process instance
test_start "create process instance"
cleanup_session
if OUTPUT=$(c8_cmd create pi --id=simple-process 2>&1); then
    debug_output "$OUTPUT"
    if echo "$OUTPUT" | grep -q "✓ Process instance created \[Key:"; then
        test_pass
    else
        test_fail "output doesn't contain '✓ Process instance created [Key:'"
    fi
else
    test_fail "create process instance failed"
fi

# Test 4: Run command and list process instances
test_start "run command and list process instances"
cleanup_session
if RUN_OUTPUT=$(c8_cmd run tests/fixtures/simple-timer-event.bpmn 2>&1); then
    debug_output "$RUN_OUTPUT"
    # Check for both deployment and instance creation messages
    if ! echo "$RUN_OUTPUT" | grep -q "✓ Deployment successful \[Key:"; then
        test_fail "output doesn't contain '✓ Deployment successful [Key:'"
    elif ! echo "$RUN_OUTPUT" | grep -q "✓ Process instance created \[Key:"; then
        test_fail "output doesn't contain '✓ Process instance created [Key:'"
    else
        # Extract instance key to verify it appears in list pi
        INSTANCE_KEY=$(echo "$RUN_OUTPUT" | grep "Process instance created" | grep -o '\[Key: [0-9]*\]' | grep -o '[0-9]*')
        
        if [ -z "$INSTANCE_KEY" ]; then
            test_fail "could not extract instance key from run output"
        else
            # Verify the instance key appears in list pi (wait time handled by c8_cmd)
            if LIST_OUTPUT=$(c8_cmd 0 list pi 2>&1); then
                debug_output "$LIST_OUTPUT"
                if echo "$LIST_OUTPUT" | grep -q "$INSTANCE_KEY"; then
                    test_pass
                else
                    test_fail "instance key $INSTANCE_KEY not found in list pi"
                fi
            else
                test_fail "list pi command failed"
            fi
        fi
    fi
else
    test_fail "run command failed"
fi

# Test 5: Get topology
test_start "get topology"
cleanup_session
if OUTPUT=$(c8_cmd 0 get topology 2>&1); then
    debug_output "$OUTPUT"
    # Verify topology output contains broker information and cluster ID
    if ! echo "$OUTPUT" | grep -q "brokers"; then
        test_fail "topology output doesn't contain 'brokers'"
    elif ! echo "$OUTPUT" | grep -q "clusterId"; then
        test_fail "topology output doesn't contain 'clusterId'"
    else
        test_pass
    fi
else
    test_fail "get topology failed"
fi

# Test 6: User task completion
test_start "user task completion"
cleanup_session
# Run process with user task
if RUN_OUTPUT=$(c8_cmd run tests/fixtures/simple-user-task.bpmn 2>&1); then
    debug_output "$RUN_OUTPUT"
    if ! echo "$RUN_OUTPUT" | grep -q "Process instance created"; then
        test_fail "failed to create process instance with user task"
    else
        # List user tasks and extract the key (wait time handled by c8_cmd)
        if LIST_UT=$(c8_cmd 0 list ut 2>&1); then
            debug_output "$LIST_UT"
            UT_KEY=$(echo "$LIST_UT" | grep -v "^Key\|^---\|^No user" | awk 'NF {print $1}' | head -n1)
            
            if [ -z "$UT_KEY" ]; then
                test_fail "no user task found after running process"
            else
                # Complete the user task
                if COMPLETE_OUTPUT=$(c8_cmd complete ut "$UT_KEY" 2>&1); then
                    debug_output "$COMPLETE_OUTPUT"
                    if ! echo "$COMPLETE_OUTPUT" | grep -q "completed"; then
                        test_fail "complete output doesn't contain 'completed'"
                    else
                        # Verify user task is no longer in the list
                        if LIST_UT_AFTER=$(c8_cmd 0 list ut 2>&1); then
                            debug_output "$LIST_UT_AFTER"
                            if echo "$LIST_UT_AFTER" | grep -q "$UT_KEY"; then
                                test_fail "user task $UT_KEY still in list after completion"
                            else
                                test_pass
                            fi
                        else
                            test_fail "list ut failed after completion"
                        fi
                    fi
                else
                    test_fail "failed to complete user task $UT_KEY"
                fi
            fi
        else
            test_fail "list ut command failed"
        fi
    fi
else
    test_fail "run command failed for user task process"
fi

# Test 7: Message correlation
test_start "message correlation"
cleanup_session
# Deploy process with c8_cmd for automatic wait
if ! c8_cmd deploy tests/fixtures/simple-message-correlation.bpmn > /dev/null 2>&1; then
    test_fail "failed to deploy message correlation process"
else
    # Create instance with variables
    if CREATE_OUTPUT=$(c8_cmd create pi --id=simple-message-correlation --variables='{"orderId":"1a"}' 2>&1); then
        debug_output "$CREATE_OUTPUT"
        # Extract instance key
        INSTANCE_KEY=$(echo "$CREATE_OUTPUT" | grep "Process instance created" | grep -o '\[Key: [0-9]*\]' | grep -o '[0-9]*')

        if [ -z "$INSTANCE_KEY" ]; then
            test_fail "could not extract instance key"
        else
            # Verify instance exists and is active
            if LIST_PI=$(c8_cmd 0 list pi 2>&1); then
                debug_output "$LIST_PI"
                if ! echo "$LIST_PI" | grep "$INSTANCE_KEY" | grep -q "ACTIVE"; then
                    test_fail "instance $INSTANCE_KEY not found or not active"
                else
                    # Publish message with correlation key (use longer wait time for message correlation)
                    if ! c8_cmd 2 publish msg "msg_1" --correlationKey=1a > /dev/null 2>&1; then
                        test_fail "failed to publish message"
                    else
                        # Verify instance is completed (no longer in active list)
                        if LIST_PI_AFTER=$(c8_cmd 0 list pi 2>&1); then
                            debug_output "$LIST_PI_AFTER"
                            if echo "$LIST_PI_AFTER" | grep "$INSTANCE_KEY" | grep -q "ACTIVE"; then
                                test_fail "instance $INSTANCE_KEY still active after message"
                            else
                                test_pass
                            fi
                        else
                            test_fail "list pi failed after message"
                        fi
                    fi
                fi
            else
                test_fail "list pi command failed"
            fi
        fi
    else
        test_fail "failed to create instance with variables"
    fi
fi

# Test 8: Search functionality
test_start "search process definitions"
cleanup_session
# Search for process definitions deployed in previous tests
if SEARCH_OUTPUT=$(c8_cmd 0 search pd --bpmnProcessId=simple-user-task 2>&1); then
    debug_output "$SEARCH_OUTPUT"
    # Verify the deployed process definition appears in search results
    if ! echo "$SEARCH_OUTPUT" | grep -q "simple-user-task"; then
        test_fail "bpmnProcessId 'simple-user-task' not found in search results"
    else
        # Test search with wildcard
        if WILDCARD_OUTPUT=$(c8_cmd 0 search pd --name='*Message*' 2>&1); then
            debug_output "$WILDCARD_OUTPUT"
            if ! echo "$WILDCARD_OUTPUT" | grep -q "Message"; then
                test_fail "wildcard search --name='*Message*' found no results"
            else
                # Test search by exact name
                if NAME_OUTPUT=$(c8_cmd 0 search pd --name='Simple User Task*' 2>&1); then
                    debug_output "$NAME_OUTPUT"
                    if ! echo "$NAME_OUTPUT" | grep -q "simple-user-task"; then
                        test_fail "search by name 'Simple User Task' found no results"
                    else
                        test_pass
                    fi
                else
                    test_fail "search by name command failed"
                fi
            fi
        else
            test_fail "wildcard search command failed"
        fi
    fi
else
    test_fail "search process definitions command failed"
fi  

# Test 9: Profile management
test_start "profile management"
cleanup_session
# Step 1: Create the profile
if ADD_OUTPUT=$(c8_cmd add profile e2e-smoke-test --baseUrl=https://camunda.example.com --clientId=xxx --clientSecret=yyy 2>&1); then
    debug_output "$ADD_OUTPUT"
    if ! echo "$ADD_OUTPUT" | grep -q "Profile 'e2e-smoke-test' added"; then
        test_fail "expected success message for profile addition"
    else
        # Step 2: Validate the existence of the profile
        if LIST_OUTPUT=$(c8_cmd 0 list profiles 2>&1); then
            debug_output "$LIST_OUTPUT"
            if ! echo "$LIST_OUTPUT" | grep -q "e2e-smoke-test"; then
                test_fail "profile 'e2e-smoke-test' not found in list after creation"
            elif ! echo "$LIST_OUTPUT" | grep -q "https://camunda.example.com"; then
                test_fail "base URL not found in profile list"
            else
                # Step 3: Delete the profile
                if REMOVE_OUTPUT=$(c8_cmd remove profile e2e-smoke-test 2>&1); then
                    debug_output "$REMOVE_OUTPUT"
                    if ! echo "$REMOVE_OUTPUT" | grep -q "Profile 'e2e-smoke-test' removed"; then
                        test_fail "expected success message for profile removal"
                    else
                        # Step 4: Evaluate the deleted list
                        if LIST_AFTER=$(c8_cmd 0 list profiles 2>&1); then
                            debug_output "$LIST_AFTER"
                            if echo "$LIST_AFTER" | grep -q "e2e-smoke-test"; then
                                test_fail "profile 'e2e-smoke-test' still appears in list after deletion"
                            else
                                test_pass
                            fi
                        else
                            test_fail "list profiles command failed after deletion"
                        fi
                    fi
                else
                    test_fail "remove profile command failed"
                fi
            fi
        else
            test_fail "list profiles command failed after creation"
        fi
    fi
else
    test_fail "add profile command failed"
fi

# Summary
echo ""
echo "=================================="
echo "📊 Test Results"
echo "=================================="
echo "Tests run:    $TESTS_RUN"
echo -e "Tests passed: ${GREEN}$TESTS_PASSED${NC}"
if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "Tests failed: ${RED}$TESTS_FAILED${NC}"
    echo ""
    echo -e "${RED}❌ Some tests failed${NC}"
    exit 1
else
    echo "Tests failed: 0"
    echo ""
    echo -e "${GREEN}✅ All smoke tests passed!${NC}"
    exit 0
fi
