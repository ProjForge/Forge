import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const path = new URL('../deploy/aws/s3-object-lock.template.json', import.meta.url)
const template = JSON.parse(await readFile(path, 'utf8'))
const resources = template.Resources
const bucket = resources.RecoveryBucket
const properties = bucket.Properties

assert.equal(bucket.Type, 'AWS::S3::Bucket')
assert.equal(bucket.DeletionPolicy, 'Retain')
assert.equal(bucket.UpdateReplacePolicy, 'Retain')
assert.equal(properties.ObjectLockEnabled, true)
assert.equal(properties.ObjectLockConfiguration.ObjectLockEnabled, 'Enabled')
assert.deepEqual(properties.ObjectLockConfiguration.Rule.DefaultRetention, {
  Mode: 'COMPLIANCE',
  Days: 30,
})
assert.equal(properties.VersioningConfiguration.Status, 'Enabled')
assert.equal(properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
  .ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256')
assert.deepEqual(properties.PublicAccessBlockConfiguration, {
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
})

const lifecycle = properties.LifecycleConfiguration.Rules[0]
assert.equal(lifecycle.Prefix, 'logical/')
assert.ok(lifecycle.ExpirationInDays > properties.ObjectLockConfiguration.Rule.DefaultRetention.Days)

const userActions = resources.RecoveryUser.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action])
const requiredActions = ['s3:GetObject', 's3:GetObjectRetention', 's3:PutObject', 's3:PutObjectRetention']
for (const action of requiredActions) assert.ok(userActions.includes(action), `missing ${action}`)
for (const forbidden of ['s3:*', 's3:DeleteObject', 's3:BypassGovernanceRetention']) {
  assert.ok(!userActions.includes(forbidden), `forbidden IAM action: ${forbidden}`)
}
assert.equal(resources.RecoveryUser.Properties.Policies[0].PolicyDocument.Statement[1]
  .Resource['Fn::Sub'], '${RecoveryBucket.Arn}/logical/*')
assert.ok(!Object.values(resources).some((resource) => resource.Type === 'AWS::IAM::AccessKey'))

const transportDeny = resources.RecoveryBucketPolicy.Properties.PolicyDocument.Statement[0]
assert.equal(transportDeny.Effect, 'Deny')
assert.equal(transportDeny.Condition.Bool['aws:SecureTransport'], 'false')
assert.ok(!JSON.stringify(template.Outputs).toLowerCase().includes('secret'))

process.stdout.write('PASS: AWS recovery deployment enforces immutable, private, least-privilege storage.\n')
