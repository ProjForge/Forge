# AWS S3 Object Lock deployment

This optional deployment provisions the reference off-site target for FORGE
Resilience. It does not change the provider-neutral recovery package or Core.

The template creates:

- a private, versioned S3 bucket in Object Lock `COMPLIANCE` mode for 30 days;
- SSE-S3 encryption in addition to FORGE client-side AES-256-GCM encryption;
- a lifecycle that expires current objects after 45 days and their resulting
  noncurrent versions after one further day;
- an IAM user restricted to upload, retention and recovery beneath `logical/`;
- a TLS-only bucket policy.

It deliberately creates no access key. Creating an access key inside the stack
would expose a long-lived secret through deployment state and outputs.

## Important

Object Lock cannot be disabled after it is enabled. In `COMPLIANCE` mode, no
principal, including the AWS account root user, can delete a protected object
version before its retention date. The stack retains the bucket if the stack is
deleted. Deploy only into an account with MFA and billing alerts configured.

## Provision

Install AWS CLI v2, authenticate an administrative bootstrap identity, choose a
globally unique bucket name and deploy in the desired off-site region:

```powershell
aws cloudformation deploy `
  --region eu-west-1 `
  --stack-name forge-recovery `
  --template-file deploy/aws/s3-object-lock.template.json `
  --parameter-overrides BucketName=YOUR-GLOBALLY-UNIQUE-BUCKET `
  --capabilities CAPABILITY_IAM `
  --no-fail-on-empty-changeset
```

Read `BucketName`, `BucketRegion`, `ObjectPrefix` and `RecoveryUserName` from
the stack outputs. Create one access key for `RecoveryUserName`, store it in the
Windows CurrentUser DPAPI-backed runtime used by the scheduled task, and remove
the administrative bootstrap credentials from the machine. Never paste the key
into policy JSON, source files, issues, CI variables or command history.

The policy target is:

```json
{
  "name": "aws-offsite-worm",
  "type": "s3",
  "bucket": "YOUR-GLOBALLY-UNIQUE-BUCKET",
  "prefix": "logical",
  "region": "eu-west-1",
  "objectLock": {
    "mode": "COMPLIANCE",
    "retentionDays": 30
  }
}
```

## Acceptance drill

1. Run `forge-resilience run-policy` with the existing local targets plus the
   AWS target. It must upload payload before manifest, download both and fully
   authenticate the encrypted package.
2. On a new local directory, run `forge-resilience fetch-s3` for that manifest.
3. Restore into a new empty database and validate migrations and table counts.
4. Confirm the two object versions report `COMPLIANCE` retention in AWS.
5. Revoke the test access key and repeat recovery with the operational key.

The provider-backed drill is complete only when all five steps have recorded
evidence in `docs/RESILIENCE-VALIDATION.md` without credentials or plaintext
backup data.
