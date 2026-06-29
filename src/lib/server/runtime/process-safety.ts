/**
 * Installe un filet de sécurité process : LOG les rejections/exceptions non gérées au lieu
 * de laisser Node crasher. Idempotent (basé sur le nombre de listeners). À appeler au boot
 * du serveur SvelteKit et du worker. Ne masque rien silencieusement : tout est loggué.
 */
export function installProcessSafetyNet(label: string): void {
	if (process.listenerCount('unhandledRejection') === 0) {
		process.on('unhandledRejection', (reason) => {
			console.error(`[${label}] UNHANDLED REJECTION (caught by safety net):`, reason);
		});
	}
	if (process.listenerCount('uncaughtException') === 0) {
		process.on('uncaughtException', (err) => {
			console.error(`[${label}] UNCAUGHT EXCEPTION (caught by safety net):`, err);
		});
	}
}
