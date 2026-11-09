import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const terraform = readFileSync(new URL('../../infra/main.tf', import.meta.url), 'utf8');

describe('Given a single-origin edge deployment', () => {
  it('routes API requests to ALB with caching disabled', () => {
    expect(terraform).toMatch(/resource "aws_cloudfront_distribution" "web"/);
    expect(terraform).toMatch(/path_pattern\s*=\s*"\/api\/\*"/);
    expect(terraform).toMatch(/target_origin_id\s*=\s*"api-alb"/);
    expect(terraform).toMatch(
      /cache_policy_id\s*=\s*data\.aws_cloudfront_cache_policy\.disabled\.id/,
    );
  });

  it('forwards browser credentials, concurrency, replay and query inputs', () => {
    expect(terraform).toMatch(/resource "aws_cloudfront_origin_request_policy" "api"/);
    for (const header of ['Origin', 'Referer', 'Idempotency-Key', 'If-Match', 'Last-Event-ID']) {
      expect(terraform).toContain(`"${header}"`);
    }
    expect(terraform).toMatch(/cookie_behavior\s*=\s*"all"/);
    expect(terraform).toMatch(/query_string_behavior\s*=\s*"all"/);
    expect(terraform).toMatch(
      /allowed_methods\s*=\s*\["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"\]/,
    );
  });

  it('uses a private S3 origin and an ALB timeout longer than SSE heartbeats', () => {
    expect(terraform).toMatch(/resource "aws_cloudfront_origin_access_control" "web"/);
    expect(terraform).toMatch(/resource "aws_s3_bucket_public_access_block" "web"/);
    expect(terraform).toMatch(/origin_read_timeout\s*=\s*60/);
    expect(terraform).toMatch(/resource "aws_lb" "api"/);
    expect(terraform).toMatch(/idle_timeout\s*=\s*60/);
  });

  it('declares an active-connection alarm and a monthly cost alert', () => {
    expect(terraform).toMatch(/resource "aws_cloudwatch_metric_alarm" "api_connections"/);
    expect(terraform).toMatch(/metric_name\s*=\s*"ActiveConnectionCount"/);
    expect(terraform).toMatch(/resource "aws_budgets_budget" "monthly"/);
  });

  it('runs at least two stateless API tasks with shared database secrets and CPU scaling', () => {
    expect(terraform).toMatch(/resource "aws_ecs_task_definition" "api"/);
    expect(terraform).toMatch(/name\s*=\s*"GAME_CREDENTIAL_ENCRYPTION_KEY"/);
    expect(terraform).toMatch(/name\s*=\s*"DATABASE_URL"/);
    expect(terraform).toMatch(/resource "aws_ecs_service" "api"/);
    expect(terraform).toMatch(/desired_count\s*=\s*2/);
    expect(terraform).toMatch(/min_capacity\s*=\s*2/);
    expect(terraform).toMatch(/predefined_metric_type\s*=\s*"ECSServiceAverageCPUUtilization"/);
    expect(terraform).not.toMatch(/stickiness\s*\{/);
  });
});
