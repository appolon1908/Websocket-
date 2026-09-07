# SIP.js staging rollback

1. Revoke the bounded SIP provisioning session and TURN REST credentials.
2. Stop the SIP.js staging container.
3. Restore the recorded previous staging image.
4. Route `phone.codestra.agency` back to the previous container port.
5. Remove/disable the endpoint 6101 synthetic-test include on VICIdial.
6. Confirm endpoint 6101 is disabled, no contact exists, Asterisk has zero
   channels/calls, and TURN has zero allocations.
7. Confirm the restored desktop reports `DIAGNOSTIC_FAIL_CLOSED`.

Rollback never enables production trunks, queues, transfers, callbacks,
workflows, synchronization, or external delivery.
