import { prisma } from '@/server/db'
import { recordAudit } from '@/server/audit'
import { markStepComplete } from '@/server/services/hotel-onboarding.service'
import { getOrCreateHotelRole } from '@/server/services/hotel-roles.service'
import { DEFAULT_DEPARTMENT_TEMPLATES, EnableDepartmentInput, RenameDepartmentInput } from '@/server/validation/department.schema'
import type { HotelSessionUser } from '@/server/require-hotel-session'

export async function listDepartments(hotelId: string) {
  const departments = await prisma.departments.findMany({
    where: { hotel_id: hotelId },
    orderBy: { name: 'asc' },
    include: {
      users: { select: { user_id: true, full_name: true } },
      _count: { select: { user_departments: true } },
    },
  })

  const existingNames = new Set(departments.map((d) => d.name))
  const availableTemplates = DEFAULT_DEPARTMENT_TEMPLATES.filter((name) => !existingNames.has(name))

  return { departments, availableTemplates }
}

/**
 * PRD §3/§5/§10 "Team" screen: eligible staff across the manager's own
 * department(s), plus each member's current workload — extends
 * `requests.service.ts`'s `listEligibleAssignees` (single-department) to
 * the multi-department case a manager can be in.
 */
export async function getManagerTeam(hotelId: string, departmentIds: string[]) {
  const departments = await prisma.departments.findMany({
    where: { hotel_id: hotelId, department_id: { in: departmentIds } },
    select: { department_id: true, name: true },
  })

  const members = await prisma.users.findMany({
    where: { hotel_id: hotelId, user_departments: { some: { department_id: { in: departmentIds } } } },
    select: {
      user_id: true,
      full_name: true,
      email: true,
      status: true,
      user_departments: {
        where: { department_id: { in: departmentIds } },
        select: { departments: { select: { department_id: true, name: true } } },
      },
      requests: { where: { status: { in: ['pending_acceptance', 'assigned', 'in_progress'] } }, select: { request_id: true } },
    },
    orderBy: { full_name: 'asc' },
  })

  return {
    departments,
    members: members.map((m) => ({
      user_id: m.user_id,
      full_name: m.full_name,
      email: m.email,
      status: m.status,
      departments: m.user_departments.map((ud) => ud.departments),
      activeWorkload: m.requests.length,
    })),
  }
}

export async function enableDepartment(hotelId: string, input: EnableDepartmentInput, actor: HotelSessionUser) {
  const department = await prisma.departments.create({
    data: { hotel_id: hotelId, name: input.name, is_custom: input.isCustom, is_enabled: true },
  })

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'department.enabled',
    entityType: 'department',
    entityId: department.department_id,
    afterState: { name: department.name, is_custom: department.is_custom },
  })

  await markStepComplete(hotelId, 'Departments')

  return department
}

export async function renameDepartment(
  hotelId: string,
  departmentId: string,
  input: RenameDepartmentInput,
  actor: HotelSessionUser
) {
  const before = await prisma.departments.findFirstOrThrow({ where: { department_id: departmentId, hotel_id: hotelId } })

  const after = await prisma.departments.update({
    where: { department_id: departmentId },
    data: { name: input.name },
  })

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'department.renamed',
    entityType: 'department',
    entityId: departmentId,
    beforeState: { name: before.name },
    afterState: { name: after.name },
  })

  return after
}

/**
 * Assign, change, or remove (managerId: null) a department's manager.
 * PRD §6/§14: every department may have one manager or none — never
 * mandatory. Assigning bumps the person's role to "Department Manager"
 * (giving them manager-level screens); removing drops them back to
 * "Department Staff" once they no longer manage any department.
 */
export async function setDepartmentManager(
  hotelId: string,
  departmentId: string,
  managerId: string | null,
  actor: HotelSessionUser
) {
  const department = await prisma.departments.findFirstOrThrow({ where: { department_id: departmentId, hotel_id: hotelId } })
  const previousManagerId = department.manager_id

  if (managerId) {
    const candidate = await prisma.users.findFirstOrThrow({
      where: { user_id: managerId, hotel_id: hotelId, user_type: 'hotel_staff' },
    })
    const managerRole = await getOrCreateHotelRole(hotelId, 'Department Manager')

    await prisma.$transaction(async (tx) => {
      await tx.departments.update({ where: { department_id: departmentId }, data: { manager_id: managerId } })
      await tx.users.update({ where: { user_id: candidate.user_id }, data: { role_id: managerRole.role_id } })
      await tx.user_departments.upsert({
        where: { user_id_department_id: { user_id: managerId, department_id: departmentId } },
        update: {},
        create: { user_id: managerId, department_id: departmentId },
      })
    })
  } else {
    await prisma.departments.update({ where: { department_id: departmentId }, data: { manager_id: null } })
  }

  if (previousManagerId && previousManagerId !== managerId) {
    await demoteIfNoLongerManaging(hotelId, previousManagerId)
  }

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: managerId ? 'department.manager_assigned' : 'department.manager_removed',
    entityType: 'department',
    entityId: departmentId,
    beforeState: { manager_id: previousManagerId },
    afterState: { manager_id: managerId },
  })

  if (managerId) {
    await markStepComplete(hotelId, 'Department Managers')
  }

  return prisma.departments.findUniqueOrThrow({
    where: { department_id: departmentId },
    include: { users: { select: { user_id: true, full_name: true } } },
  })
}

async function demoteIfNoLongerManaging(hotelId: string, userId: string) {
  const stillManaging = await prisma.departments.count({ where: { hotel_id: hotelId, manager_id: userId } })
  if (stillManaging > 0) return

  const staffRole = await getOrCreateHotelRole(hotelId, 'Department Staff')
  await prisma.users.update({ where: { user_id: userId }, data: { role_id: staffRole.role_id } })
}

/** Name lookup for a known department-id set — used by the Staff Home/Tasks pages' department chips. */
export async function getDepartmentsByIds(hotelId: string, departmentIds: string[]) {
  return prisma.departments.findMany({
    where: { hotel_id: hotelId, department_id: { in: departmentIds } },
    select: { department_id: true, name: true },
    orderBy: { name: 'asc' },
  })
}

export async function toggleDepartmentEnabled(hotelId: string, departmentId: string, actor: HotelSessionUser) {
  const before = await prisma.departments.findFirstOrThrow({ where: { department_id: departmentId, hotel_id: hotelId } })

  const after = await prisma.departments.update({
    where: { department_id: departmentId },
    data: { is_enabled: !before.is_enabled },
  })

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: after.is_enabled ? 'department.enabled' : 'department.disabled',
    entityType: 'department',
    entityId: departmentId,
    beforeState: { is_enabled: before.is_enabled },
    afterState: { is_enabled: after.is_enabled },
  })

  return after
}
