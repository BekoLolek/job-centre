# Event lifecycle

Serves UC-09 (R-33 to R-39). Status names are the UI's; code values in brackets.

```mermaid
stateDiagram-v2
    [*] --> Unpublished : admin creates (UC-08)
    Unpublished --> Published : publish\n[name, >=1 day, sign-up window set]
    Published --> Unpublished : unpublish\n(applications kept)
    Published --> Running : mark running
    Published --> Cancelled : cancel\n(notify applicants)
    Running --> Cancelled : cancel\n(notify applicants)
    Running --> Complete : mark complete
    Complete --> Running : reopen\n(records who)

    note right of Complete
        Read-only: setup, applications, teams,
        draft, stages and results refuse every change.
    end note
    note right of Unpublished
        Visible to managers only. (code: draft)
    end note
    note left of Running
        code: live
    end note
```

| From | To | Who | Guard | Side effects |
|---|---|---|---|---|
| Unpublished | Published | Manager | name, at least one day, sign-up window | notify "event published"; announcement |
| Published | Unpublished | Manager | - | hidden again; applications kept |
| Published | Running | Manager | - | shown as live on the front page |
| Published / Running | Cancelled | Manager | - | notify applicants; stays in the archive |
| Running | Complete | Manager | - | moves to the archive; read-only |
| Complete | Running | Manager | - | audit entry naming who reopened |

Any other transition is refused (UC-09 3a). Cancelled is terminal.
