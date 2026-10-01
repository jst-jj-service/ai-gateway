# AI Gateway — Quick Connection & Setup Guide

Welcome to **AI Gateway**, a high-performance, low-latency API proxy supporting OpenAI and Anthropic Claude models with 6 transparent routing pools.

- **Base URL (OpenAI Endpoints):** `https://jj-ai-gateway.onrender.com/v1`
- **Base URL (Anthropic Endpoints):** `https://jj-ai-gateway.onrender.com`
- **Supported Formats:**
  - OpenAI Chat Completions: `POST /v1/chat/completions`
  - OpenAI Responses API: `POST /v1/responses`
  - Anthropic Messages API: `POST /v1/messages` and `POST /messages`
  - Model Catalog: `GET /v1/models`

---

## 1. Claude Code CLI Setup

AI Gateway has full native support for Claude Code CLI and the Anthropic Messages API.

### macOS / Linux / WSL:
```bash
export ANTHROPIC_BASE_URL="https://jj-ai-gateway.onrender.com"
export ANTHROPIC_API_KEY="sk-gw-your-api-key"

# Run Claude Code CLI
claude
```

### Windows PowerShell:
```powershell
$env:ANTHROPIC_BASE_URL="https://jj-ai-gateway.onrender.com"
$env:ANTHROPIC_API_KEY="sk-gw-your-api-key"

# Run Claude Code CLI
claude
```

Claude Code will automatically route through the Claude Max pool (`claude-3-7-sonnet-20250219`) with full hybrid thinking support.

---

## 2. Cursor IDE Setup

1. Open Cursor **Settings** &rarr; **Models**.
2. Turn off "Use built-in OpenAI API key".
3. Turn on **OpenAI API Key** and paste your Gateway API key (`sk-gw-...`).
4. Click **Override OpenAI Base URL** and enter:
   ```
   https://jj-ai-gateway.onrender.com/v1
   ```
5. In the model selector, add and choose any supported model:
   - `astra` or `gpt-6-astra` (Flagship Pro Pool @ 0.45x)
   - `sol` or `gpt-5.6-sol` (Pro Reasoning Pool @ 0.45x)
   - `gpt-4o` (Plus Pool @ 0.325x)
   - `claude-3-7-sonnet-20250219` (Claude Max Pool @ 3.00x)

---

## 3. Anthropic Python SDK

Install the official SDK:
```bash
pip install anthropic
```

Usage:
```python
import anthropic

client = anthropic.Anthropic(
    api_key="sk-gw-your-api-key",
    base_url="https://jj-ai-gateway.onrender.com"
)

message = client.messages.create(
    model="claude-3-7-sonnet-20250219",  # or claude-opus-5, fable, etc.
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "Explain how distributed cache consensus works."}
    ]
)

print(message.content[0].text)
```

---

## 4. Anthropic Node.js / TypeScript SDK

Install the official package:
```bash
npm install @anthropic-ai/sdk
```

Usage:
```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: 'sk-gw-your-api-key',
  baseURL: 'https://jj-ai-gateway.onrender.com',
});

const message = await anthropic.messages.create({
  model: 'claude-3-7-sonnet-20250219',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Generate a TypeScript state machine' }],
});

console.log(message.content[0].text);
```

---

## 5. OpenAI Python SDK

Install the official SDK:
```bash
pip install openai
```

Usage:
```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-gw-your-api-key",
    base_url="https://jj-ai-gateway.onrender.com/v1"
)

# Stream response from Astra Flagship
response = client.chat.completions.create(
    model="astra",  # or "sol", "gpt-4o", "gpt-4o-mini"
    messages=[
        {"role": "user", "content": "Write a clean binary search in Python."}
    ],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
```

---

## 6. OpenAI Node.js / TypeScript SDK

Install the official package:
```bash
npm install openai
```

Usage:
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: 'sk-gw-your-api-key',
  baseURL: 'https://jj-ai-gateway.onrender.com/v1',
});

const response = await openai.chat.completions.create({
  model: 'sol',  # Sol Reasoning Model
  messages: [{ role: 'user', content: 'Explain AVL tree balancing algorithms' }],
  stream: true,
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

---

## 7. Cline, Roo-Code & Windsurf (VS Code)

- **Provider:** Anthropic Compatible (or OpenAI Compatible)
- **Base URL (Anthropic):** `https://jj-ai-gateway.onrender.com`
- **Base URL (OpenAI):** `https://jj-ai-gateway.onrender.com/v1`
- **API Key:** `sk-gw-your-api-key`
- **Model:** `claude-3-7-sonnet-20250219`, `astra`, or `sol`

---

## 8. Direct cURL Examples

### OpenAI Chat Completions:
```bash
curl https://jj-ai-gateway.onrender.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-gw-your-api-key" \
  -d '{
    "model": "astra",
    "messages": [{"role": "user", "content": "Hello Astra!"}],
    "stream": false
  }'
```

### Anthropic Messages API:
```bash
curl https://jj-ai-gateway.onrender.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-gw-your-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-7-sonnet-20250219",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello Claude!"}]
  }'
```

### List Models:
```bash
curl https://jj-ai-gateway.onrender.com/v1/models \
  -H "Authorization: Bearer sk-gw-your-api-key"
```

---

## 9. Active Routing Pools & Multipliers

| Pool | Deduction Multiplier | Top Models | Best For |
|---|---|---|---|
| **Starter Pool** | `0.16x` | `gpt-4o-mini`, `gpt-5.4-mini` | Automation & high-frequency bots |
| **Plus Pool** | `0.325x` | `gpt-4o`, `chatgpt-4o-latest` | Daily production & Cursor IDE |
| **Pro Reasoning** | `0.45x` | `sol`, `terra`, `gpt-5.6-sol` | Deep reasoning, math & STEM logic |
| **Flagship Pro** | `0.45x` | `astra`, `gpt-6-astra`, `o1`, `o3-mini` | Frontier intelligence & agents |
| **Claude Standard** | `0.24x` | `claude-opus-5`, `claude-sonnet-5`, `fable` | Anthropic Opus & Sonnet reasoning |
| **Claude Max** | `3.00x` | `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet` | Claude Code CLI & hybrid thinking |

*Balance is permanent and never expires. Automatic prompt caching discounts apply on repeated context.*
