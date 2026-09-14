"""Wire-name compatibility for native Hermes running with MCP Python 2.x.

Only missing read aliases are installed in Studio's process. The SDK retains
its native fields and serialization; Hermes sees its expected 1.x interface.
"""


def alias(model, wire_name, native_name):
    fields = getattr(model, 'model_fields', {})
    if native_name in fields and wire_name not in fields and not hasattr(model, wire_name):
        setattr(model, wire_name, property(lambda self: getattr(self, native_name)))


def install():
    import os
    if os.environ.get('HERMES_STUDIO_RUNTIME') != '1': return
    from mcp.types import Tool, CallToolResult
    alias(Tool, 'inputSchema', 'input_schema')
    alias(CallToolResult, 'isError', 'is_error')
