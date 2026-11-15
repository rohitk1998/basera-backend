import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ReportEntity,
  StayChatMessageEntity,
  StoryEntity,
  MeetupEntity,
  UserBlockEntity,
  UserEntity,
} from '../entities';
import { findBlockRelatedUserIds } from './social-blocks.util';
import type {
  CreateReportDto,
  ReportTargetType,
} from './dto/create-report.dto';

@Injectable()
export class SocialSafetyService {
  constructor(
    @InjectRepository(UserBlockEntity)
    private readonly blocksRepo: Repository<UserBlockEntity>,
    @InjectRepository(ReportEntity)
    private readonly reportsRepo: Repository<ReportEntity>,
    @InjectRepository(UserEntity)
    private readonly usersRepo: Repository<UserEntity>,
    @InjectRepository(StoryEntity)
    private readonly storiesRepo: Repository<StoryEntity>,
    @InjectRepository(MeetupEntity)
    private readonly meetupsRepo: Repository<MeetupEntity>,
    @InjectRepository(StayChatMessageEntity)
    private readonly messagesRepo: Repository<StayChatMessageEntity>,
  ) {}

  /** User ids in a block relationship with `userId`, in either direction. */
  async blockedIdsFor(userId: string): Promise<string[]> {
    return [...(await findBlockRelatedUserIds(this.blocksRepo, userId))];
  }

  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId)
      throw new BadRequestException('You cannot block yourself.');
    if (!(await this.usersRepo.exists({ where: { id: blockedId } })))
      throw new NotFoundException('User not found.');
    await this.blocksRepo
      .createQueryBuilder()
      .insert()
      .values({ blocker_id: blockerId, blocked_id: blockedId })
      .orIgnore()
      .execute();
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.blocksRepo.delete({
      blocker_id: blockerId,
      blocked_id: blockedId,
    });
  }

  async createReport(
    reporterId: string,
    dto: CreateReportDto,
  ): Promise<{ id: string }> {
    const ownerId = await this.resolveTargetOwner(dto.targetType, dto.targetId);
    if (ownerId === reporterId)
      throw new BadRequestException('You cannot report yourself.');

    // One open report per reporter and target; repeating the report is a no-op.
    const existing = await this.reportsRepo.findOne({
      where: {
        reporter_id: reporterId,
        target_type: dto.targetType,
        target_id: dto.targetId,
        status: 'open',
      },
      select: { id: true },
    });
    if (existing) return { id: existing.id };

    const saved = await this.reportsRepo.save(
      this.reportsRepo.create({
        reporter_id: reporterId,
        target_type: dto.targetType,
        target_id: dto.targetId,
        reason: dto.reason.slice(0, 500),
      }),
    );
    return { id: saved.id };
  }

  /** Throws 404 when the target does not exist; returns the user who owns it, to block self-reports. */
  private async resolveTargetOwner(
    type: ReportTargetType,
    id: string,
  ): Promise<string | null> {
    switch (type) {
      case 'user': {
        if (!(await this.usersRepo.exists({ where: { id } })))
          throw new NotFoundException('Report target not found.');
        return id;
      }
      case 'story': {
        const row = await this.storiesRepo.findOne({
          where: { id },
          select: { id: true, author_id: true },
        });
        if (!row) throw new NotFoundException('Report target not found.');
        return row.author_id;
      }
      case 'meetup': {
        const row = await this.meetupsRepo.findOne({
          where: { id },
          select: { id: true, host_user_id: true },
        });
        if (!row) throw new NotFoundException('Report target not found.');
        return row.host_user_id;
      }
      case 'message': {
        const row = await this.messagesRepo.findOne({
          where: { id },
          select: { id: true, sender_id: true },
        });
        if (!row) throw new NotFoundException('Report target not found.');
        return row.sender_id;
      }
    }
  }
}
