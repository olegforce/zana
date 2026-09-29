import type { CreateTerminalRequest, Project } from '@zana-ai/zcc-domain/product';

/** The legacy PTY coordinator can only execute on its own enrolled host (or
 * its existing SSH backend). Do not treat a remote checkout's path as local. */
export function cliHostProblem(request: Pick<CreateTerminalRequest, 'hostId'>, project: Pick<Project, 'hostId'> | undefined, localHostId?: string): string | undefined {
  const requested = request.hostId;
  if (requested !== undefined && (typeof requested !== 'string' || !requested)) return 'Choose a valid execution machine.';
  if ((requested && requested !== localHostId) || (project?.hostId && project.hostId !== localHostId)) {
    return 'CLI Agents on secondary machines are not available yet. Use a Modern thread on that machine.';
  }
  return undefined;
}

/** Team workers use the primary CLI coordinator. Check before inspecting source
 * files or reserving an execution, including calls made by a Modern owner. */
export function teamHostProblem(project: Pick<Project, 'hostId'>, localHostId?: string): string | undefined {
  if (project.hostId && project.hostId !== localHostId) {
    return 'Squad/Team execution on secondary machines is not available yet. Choose a project on the primary machine.';
  }
  return undefined;
}
