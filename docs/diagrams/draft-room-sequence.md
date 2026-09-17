# Live draft room

Serves UC-16, UC-17 (R-65 to R-70). Drawn because three parties see one lot through polling,
and the order - lock, re-read, write, then everybody catches up on their next poll - is what
keeps two bids or an award and a bid from crossing.

```mermaid
sequenceDiagram
    autonumber
    actor M as Manager
    actor C as Captain
    actor V as Visitors
    participant S as Server actions
    participant DB as Postgres

    M->>S: open next lot (wheel)
    S->>DB: lock event row
    S->>DB: refuse if a lot is open; lock draft rules on first lot
    S->>DB: insert lot + stored spin (seed, startedAt)
    S-->>M: room payload

    loop every 1 s, while the tab is visible
        V->>S: poll room
        S->>DB: read lots, bids, rosters
        S-->>V: payload filtered by bid visibility, name hidden mid-spin
    end
    Note over V,M: every client animates the same stored spin<br/>from startedAt + server clock offset

    C->>S: place bid(amount)
    S->>DB: lock event row, re-read lot status
    S->>DB: check balance, roster-fill ceiling, open-bid increment
    alt allowed
        S->>DB: insert or raise bid
        S-->>C: accepted, new maximum
    else refused
        S-->>C: reason with the maximum or minimum
    end

    M->>S: award lot
    S->>DB: lock event row, re-read lot and bids
    S->>DB: refuse unless the team holds the highest bid (ties: manager picks among tied)
    S->>DB: lot awarded, roster place at bid price
    S-->>M: room payload
    V->>S: next poll shows the award
```
