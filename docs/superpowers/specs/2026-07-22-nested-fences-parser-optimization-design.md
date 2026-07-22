# Nested Code Fences Parser Optimization Design Specification

This specification details the optimization of nested Markdown code fence normalization (`normalizeNestedCodeFences`) to resolve a structural upgrade bug under multi-level nesting.

## Goal
Ensure that when a code fence is deeply nested within multiple layers of code fences, the backtick/tilde count of *all* parent fences is upgraded correctly to maintain the hierarchy constraint required by the CommonMark specification (parent count > child count).

## Problem Analysis
In `src/channels/telegram/formatter/core.ts`, `normalizeNestedCodeFences` parses fence lines and updates `top.maxInnerCount` to keep track of nested fence sizes.
Currently, when a fence line $F$ matches, the code only updates `top.maxInnerCount` for the immediate parent at the top of the stack:
```typescript
if (f.char === top.fence.char && f.count >= top.fence.count) {
  top.maxInnerCount = Math.max(top.maxInnerCount, f.count);
}
```
If we have three levels of nested fences (e.g., Level 1 contains Level 2, Level 2 contains Level 3), and Level 3 uses 4 backticks, the logic will upgrade Level 2's fence to 5 backticks. However, Level 1's fence will not be upgraded because the loop only tracks the immediate parent (Level 2). This causes Level 2 to end up with more backticks (5) than Level 1 (4), breaking the nesting hierarchy.

## Optimization Design
Modify the loop inside `normalizeNestedCodeFences` to propagate the inner fence count to *all* active parent fences on the current stack:
```typescript
// Update maxInnerCount for ALL parent fences in the stack
for (const item of stack) {
  if (f.char === item.fence.char) {
    item.maxInnerCount = Math.max(item.maxInnerCount, f.count);
  }
}
```

## Verification Plan
1. Add a test case in `src/channels/telegram/formatter.test.ts` that includes a 3-level nested code block structure and asserts that the outer-most fence upgrades properly.
2. Run `npm run build && npm test` to verify zero compile errors and that all tests pass.
