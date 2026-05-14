#!/bin/bash
CONTEXT=$(cat)

STRONG_PATTERNS="fixed|workaround|gotcha|that's wrong|check again|we already|should have|discovered|realized|turns out|regression|broken|reverted"
WEAK_PATTERNS="error|bug|issue|problem|fail|selector|drift|stale"

if echo "$CONTEXT" | grep -qiE "$STRONG_PATTERNS"; then
    cat << 'EOF'
{
  "decision": "approve",
  "systemMessage": "This session involved fixes or discoveries. Update AI_HANDOFF.md and the memory files in .claude/projects/.../memory/ if anything non-obvious was learned."
}
EOF
elif echo "$CONTEXT" | grep -qiE "$WEAK_PATTERNS"; then
    echo '{"decision":"approve","systemMessage":"If something non-obvious was learned this session (a gotcha, a fragile area, a constraint), update the memory files."}'
else
    echo '{"decision":"approve"}'
fi
