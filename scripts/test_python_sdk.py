import asyncio
import sys
import json

# Monkey-patch the Python validation check in the SDK to avoid needing any API key,
# allowing the Go localharness binary to safely fall back to the OAuth keyring login.
from google.antigravity.connections.local.local_connection import LocalConnectionStrategy
LocalConnectionStrategy._validate_connection = lambda self: None

from google.antigravity import Agent
from google.antigravity.connections.local.local_connection_config import LocalAgentConfig
from google.antigravity.hooks import policy
from google.antigravity import types

async def main():
    prompt = "证明：任何奇素数 p 都可以表示为两个连续整数的平方差。如果要求 x, y 必须是正整数，请详述你的推导思考过程。"
    
    # Create config matching our CLI setup
    config = LocalAgentConfig(
        model="Gemini 3.5 Flash (Medium)",
        policies=[policy.allow_all()],  # Disable interactive permission prompts for tools
        workspaces=["/home/user/Documents/通用知识专家_RichText"]
    )
    
    print("--- Starting Agent Session ---", flush=True)
    async with Agent(config) as agent:
        print(f"Agent session started. Conv ID: {agent.conversation_id}", flush=True)
        
        # Send prompt and iterate through chunk events
        chat_response = await agent.chat(prompt)
        async for chunk in chat_response:
            # Print details of the chunk as requested in Step 2
            chunk_type = type(chunk).__name__
            has_thought = isinstance(chunk, types.Thought)
            has_text = isinstance(chunk, types.Text)
            has_tool = isinstance(chunk, types.ToolCall)
            
            event_data = {
                "class": str(type(chunk)),
                "type": chunk_type,
                "repr": repr(chunk),
                "vars": vars(chunk),
                "contains_thinking": has_thought,
                "contains_text": has_text,
                "contains_tool_calls": has_tool,
                "text": chunk.text if hasattr(chunk, "text") else None
            }
            print(json.dumps(event_data, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    asyncio.run(main())
