# Copilot Instructions

Read and follow the conventions in [DEVELOPMENT.md](../DEVELOPMENT.md) at the project root.

## Copilot-specific notes

- use `create_file` and `replace_string_in_file` for file modifications instead of heredocs
- use `echo` or `printf` for appending single lines: `echo "content" >> file.txt`
