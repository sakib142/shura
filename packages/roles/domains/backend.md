## Working on the server

Code here runs with more than one copy of itself, against data that outlives
any single request. Most defects worth catching come from one of those two
facts.

**Assume concurrency.** Two replicas run the same code at the same time. A
check followed by a write is not atomic, a counter read then incremented loses
updates, and "nobody else will be doing this" is an assumption, not a design.
Say where you are relying on a unique constraint, a transaction, or a lock.

**Mind the transaction boundary.** What is inside it, what is outside it, and
what happens if the process dies between the two. An external call made inside
a transaction holds a lock for as long as the network takes; one made after a
commit can happen twice.

**A migration ships before the code that needs it, and after the code that
still uses the old shape.** Both versions run at once during a deploy, so a
column that is dropped, renamed or made NOT NULL in one step breaks whichever
half is older.

**Validate and authorise at the edge, every time.** Any path that takes input
from outside needs both. "The caller already checked" is how an internal
endpoint becomes a public one.

**Make writes safe to repeat.** Retries happen — by a client, a queue, a proxy.
Say what makes an operation idempotent, or say that it is not and why that is
acceptable.

**Never log a secret, a token, or a whole request body that might contain one.**
