# Exa MCP

Local and remote Model Context Protocol server exposing Exa web search, content fetching, and Agent research tools over pooled or per-request credentials.

## Language

**Key Pool**:
The ordered collection of Exa API credentials configured for a server instance, from which tool requests draw an active credential.
_Avoid_: Key list, key ring, key array

**Pool Key**:
A single Exa API credential registered in the Key Pool, tracked operationally by an irreversible fingerprint rather than its raw secret.
_Avoid_: Token, account key, free key

**Team Credit**:
The monthly grant and one-time onboarding balance belonging to an Exa team; multiple API keys created under the same team share one balance and rate limit.
_Avoid_: Key quota, per-key balance

**Selection Strategy**:
The ordering rule (`Fill-First` or `Round-Robin`) used to choose the next `Available` Pool Key for an unpinned operation.
_Avoid_: Load balancer, routing mode

**Key State**:
The current operational availability of a Pool Key: `Available`, `Cooldown`, `Exhausted`, or `Disabled`.
_Avoid_: Key health, status flag

**Exhausted Key**:
A Pool Key whose Team Credit is depleted until its next reset boundary (such as the start of the next UTC calendar month).
_Avoid_: Dead key, empty key

**Cooldown Key**:
A Pool Key temporarily withheld from selection after hitting a short-term rate or concurrency ceiling.
_Avoid_: Throttled key, backed-off key

**Disabled Key**:
A Pool Key excluded from automatic selection because Exa rejected the credential or its owning team as invalid or blocked.
_Avoid_: Banned key, dead key

**Run Pinning**:
Binding a stateful multi-step operation (an Agent run or deep research task) to the exact Pool Key that created it so follow-up checks remain within the owning Exa team.
_Avoid_: Sticky session, key affinity

**Failover**:
Retrying an unpinned operation with the next `Available` Pool Key when the current key fails due to a key-scoped credential, rate, or credit error.
_Avoid_: Key hopping, fallback
