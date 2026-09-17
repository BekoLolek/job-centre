# Draft lot lifecycle

Serves UC-16, UC-17 (R-64 to R-69).

```mermaid
stateDiagram-v2
    [*] --> Open : manager puts player up\n[no other lot open]
    Open --> Awarded : manager closes, highest bid wins
    Open --> Discarded : no bids, manager discards
    Open --> Reserved : manager sends to reserve pool
    Awarded --> Voided : manager undoes
    Reserved --> [*] : player comes up once more\nas a new lot in the reserve pool
    Discarded --> [*]
    Voided --> [*]
```

| Transition | Effect |
|---|---|
| to Open | captains may bid (UC-17); the room sees who is up |
| Open to Awarded | roster place created at the bid price; balance falls |
| Awarded to Voided | roster place removed; balance restored; lot kept for history |
| Open to Reserved | player returns as a new `reserve` lot after the main pool is empty; a reserve lot cannot be reserved again |

DraftRules lock when the first lot opens.
