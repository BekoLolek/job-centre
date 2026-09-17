# Host application lifecycle

Serves UC-20, UC-21 (R-83 to R-86).

```mermaid
stateDiagram-v2
    [*] --> Pending : member submits\n[no other pending]
    Pending --> Approved : admin approves, naming the event\n(creates HostGrant, notifies)
    Pending --> Declined : admin declines with reason\n(notifies)
    Pending --> Withdrawn : member withdraws
    Approved --> [*]
    Declined --> [*]
    Withdrawn --> [*]
```

Approval is refused unless the named event exists. The grant is the permission; the
application is only the record of how it was asked for.
