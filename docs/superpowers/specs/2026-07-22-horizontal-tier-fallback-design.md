# Horizontal Tier-First Circular Fallback Design Specification

This document details the transition from the old channel-restricted fallback model mapping to a unified, capability-based horizontal fallback queue.

## Goal
Optimize model fallback transitions when an upstream API failure (such as rate limits or outages) is encountered. By prioritizing model capability (Tier) over raw channel boundaries, we ensure that the assistant maintains a similar level of reasoning intelligence before downgrading to a weaker model class.

## Capability Tiers Definition
All supported models are classified into 4 distinct capability tiers, ordered from highest reasoning capability to lowest:

### Tier 1: Ultra Reasoning (T1)
*   `Claude Opus 4.6 (Thinking)`
*   `DeepSeek: Pro Thinking`

### Tier 2: Advanced Reasoning (T2)
*   `Claude Sonnet 4.6 (Thinking)`
*   `Web2API: Gemini 3.1 Pro Enhanced`
*   `Gemini 3.1 Pro (High)`
*   `Web2API: Gemini 3.1 Pro`
*   `DeepSeek: Pro`
*   `Gemini 3.1 Pro (Low)`

### Tier 3: General Capability (T3)
*   `Gemini 3.6 Flash (High)`
*   `Web2API: Gemini 3.5 Flash Thinking`
*   `DeepSeek: Flash Thinking Search`
*   `Gemini 3.6 Flash (Medium)`
*   `DeepSeek: Flash Thinking`
*   `Web2API: Gemini 3.5 Flash Thinking Lite`
*   `Gemini 3.6 Flash (Low)`
*   `GPT-OSS 120B (Medium)`
*   `Web2API: Gemini 3.5 Flash`

### Tier 4: Speed & Light (T4)
*   `Gemini 3.5 Flash (High)`
*   `DeepSeek: Flash Search`
*   `Gemini 3.5 Flash (Medium)`
*   `DeepSeek: Flash`
*   `Web2API: Gemini Auto`
*   `Gemini 3.5 Flash (Low)`
*   `Web2API: Gemini Flash Lite`

---

## Circular Fallback Algorithm
The fallback chain traversal starting from any initial model `M` behaves like a circular queue:
1.  Locate index `idx` of `M` within the unified list `ORDERED_MODELS`.
2.  If `idx` is found, build the chain:
    *   Append models from `idx` to the end of the array.
    *   Wrap around and append models from index `0` up to `idx - 1`.
3.  If `idx` is not found (custom model), prepend it to the entire list.
4.  Each model in the chain is attempted up to `RETRIES_PER_MODEL` (3) times.
5.  If a model fails, transition to the next in the chain. The queue naturally terminates when the model just before `M` fails, covering a full single pass of all models.

---

## Testing Plan
*   **Unit Tests (`messageLoop.test.ts`)**:
    *   Verify that starting with a middle model like `Gemini 3.1 Pro (Low)` yields the correct circular fallback chain.
    *   Verify that starting with `Web2API: Gemini Flash Lite` correctly wraps around to `Claude Opus 4.6 (Thinking)` and ends at `Gemini 3.5 Flash (Low)`.
    *   Ensure that the overall test count (152) passes successfully.
