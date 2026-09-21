# Multi-Account Isolation

Multiple accounts for one provider are first-class resources. An account profile is an identifier and configuration reference, not a container for raw passwords.

Where a provider officially supports isolated state directories, processes, device logins, or OAuth profiles, AI Router should give each profile a separate private state boundary. Signing out of one profile must not invalidate another. Globally swapping a single authentication file is not an acceptable final design.

Public configuration may refer to profile IDs, but authentication artifacts belong under the private runtime root or provider-managed secure storage. Logs and handoffs may record a non-secret profile identifier only.

The current platform persists non-secret profile metadata under the private runtime root and supports multiple profiles per provider. It records optional profile identifiers in handoffs but does not authenticate accounts or manipulate existing provider state.
