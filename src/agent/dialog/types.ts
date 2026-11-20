export interface DialogRequest {
  title: string;
  /** Plain text; backends escape it as needed. */
  message: string;
  timeoutSec: number;
}

export type DialogOutcome = 'continue' | 'cancel' | 'timeout';

export interface DialogBackend {
  name: string;
  available(): Promise<boolean>;
  show(req: DialogRequest): Promise<DialogOutcome>;
}
