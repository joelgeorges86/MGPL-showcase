# Agentic Multi-File XML Delimiters (Vibe Coding Manual v5.0.2)

## 1. Multi-File Context Format
When operating in long-context or multi-file agentic sessions, encapsulate dependent source files using standardized `<source_file>` XML delimiters.

```xml
<source_file path="src/path/file.ts">
// Complete file content here
</source_file>
```

## 2. Usage Directives
- **Explicit Paths**: Always set the `path` attribute relative to workspace root.
- **Completeness**: Do NOT truncate file contents within XML blocks.
- **Parsing Compatibility**: Maintain valid XML structure to ensure cross-engine compatibility across Tier 1, Tier 2, and Tier 2A models.
