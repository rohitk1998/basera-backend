import { createServer, Server, Socket } from 'net';
import { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

describe('RedisService with a connection that never answers', () => {
  let server: Server;
  let sockets: Socket[];
  let service: RedisService;

  beforeEach(async () => {
    sockets = [];
    server = createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const config = { get: () => `redis://127.0.0.1:${port}` } as unknown as ConfigService;
    service = new RedisService(config);
  });

  afterEach(async () => {
    (service as any).client.disconnect();
    sockets.forEach((s) => s.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('get falls back to a miss instead of hanging', async () => {
    const started = Date.now();
    await expect(service.get('k')).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(6000);
  }, 15000);

  it('set reports that nothing was stored instead of hanging', async () => {
    const started = Date.now();
    await expect(service.set('k', 'v', 60)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(6000);
  }, 15000);

  it('drops the dead connection after a timeout so the next call gets a fresh one', async () => {
    await service.get('k');
    await new Promise((r) => setTimeout(r, 1500));
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  }, 15000);
});
