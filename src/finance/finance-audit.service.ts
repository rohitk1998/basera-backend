import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

@Injectable()
export class FinanceAuditService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async log(
    actor: string | null,
    action: string,
    entity: string,
    entityId: string | null,
    data: Record<string, unknown> = {},
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.dataSource).query(
      'insert into finance_audit_log (actor, action, entity, entity_id, data) values ($1,$2,$3,$4,$5::jsonb)',
      [actor, action, entity, entityId, JSON.stringify(data)],
    );
  }
}
