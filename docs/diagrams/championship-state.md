# Championship lifecycle

Serves UC-31, UC-35 (R-189, R-190, R-191).

```mermaid
stateDiagram-v2
    [*] --> Hidden : admin creates
    Hidden --> Published : publish
    Published --> Hidden : unpublish\n(no standings shown)
    Published --> Closed : close the season\n(final standings stand)
    Closed --> Published : reopen\n(records who)
```

| From | To | Guard | Side effects |
|---|---|---|---|
| Hidden | Published | name, a points table | the navigation item appears; the page is public |
| Published | Hidden | - | hidden again; events and places are kept |
| Published | Closed | every counting event has a result, or the admin confirms closing without it | standings stop changing |
| Closed | Published | - | audit entry naming who reopened |

While `Closed`, recording or correcting a place is refused with "This championship is
finished - reopen it to change it", the same shape as a finished event (UC-09 6b).

## How a season is scored

```mermaid
flowchart LR
    P[Placement: position + subject] --> R{subject}
    R -->|team| M[every member of that team]
    R -->|member| M
    M --> V["value = table[position] x weight"]
    T[took part, not placed] --> W["value = participation x weight"]
    V --> S[sum per member]
    W --> S
    S --> B{countBest set?}
    B -->|yes| K[keep each member's best N]
    B -->|no| K2[keep all]
    K --> O[order by points, then most firsts, then most seconds...]
    K2 --> O
```

Nothing in that chain is stored: correcting a placement re-runs it, which is why a
correction cannot leave a stale total behind (R-79's rule, applied to the season).
