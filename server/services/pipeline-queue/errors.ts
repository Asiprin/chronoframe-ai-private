/**
 * 队列任务不可重试错误。
 *
 * 抛出此错误表示重试也不会成功（例如配置缺失、文件不存在、认证失败），
 * QueueManager 会直接将任务标记为失败，不再进入指数退避重试。
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonRetryableError'
  }
}
