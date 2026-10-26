// API 1 set_state interpolated variables inside custom dropdown strings itself. API 2
// resolves expressions before callbacks; preserve that specific old behaviour on placed
// actions without touching their IDs, other options, or feedback styles.
export function upgradeLegacyStateExpressions(_context, props) {
 const updatedActions = []
 for (const action of props.actions) {
  if (action.actionId !== 'set_state') continue
  const option = action.options?.state
  const raw = typeof option === 'string' ? option : option?.isExpression === false ? option.value : null
  if (typeof raw !== 'string' || !/\$\([^)]+\)/.test(raw)) continue
  const pieces = raw.split(/(\$\([^)]+\))/g).filter(Boolean)
  const expression = ['""', ...pieces.map((part) => /^\$\([^)]+\)$/.test(part) ? part : JSON.stringify(part))].join(' + ')
  updatedActions.push({ ...action, options: { ...action.options, state: { isExpression: true, value: expression } } })
 }
 return { updatedConfig: null, updatedActions, updatedFeedbacks: [] }
}
