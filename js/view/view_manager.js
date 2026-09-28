// ============================================================
// View Manager
//
// Owns application visualization modes.
//
// ViewManager decides which view is active.
// Individual views remain responsible for their own rendering.
// ============================================================

export class ViewManager {
	constructor() {
		this.views = new Map();
		this.activeViewName = null;
	}

	// ========================================================
	// Registration
	// ========================================================

	register(name, view) {
		if (!name || typeof name !== "string") {
			throw new Error("View name must be a non-empty string.");
		}

		if (!view) {
			throw new Error(`Cannot register empty view: ${name}`);
		}

		if (this.views.has(name)) {
			throw new Error(`View already registered: ${name}`);
		}

		this.views.set(name, view);

		return this;
	}

	unregister(name) {
		if (this.activeViewName === name) {
			this.activeViewName = null;
		}

		this.views.delete(name);

		return this;
	}

	// ========================================================
	// View Switching
	// ========================================================

	setView(name) {
		const nextView = this.views.get(name);

		if (!nextView) {
			throw new Error(`Unknown view: ${name}`);
		}

		if (this.activeViewName === name) {
			return this;
		}

		const previousView = this.getActiveView();

		if (previousView) {
			previousView.setVisible(false);
		}

		nextView.setVisible(true);

		this.activeViewName = name;

		return this;
	}

	// ========================================================
	// Queries
	// ========================================================

	getView(name) {
		return this.views.get(name) ?? null;
	}

	getActiveView() {
		if (this.activeViewName === null) {
			return null;
		}

		return this.views.get(this.activeViewName) ?? null;
	}

	getActiveViewName() {
		return this.activeViewName;
	}

	hasView(name) {
		return this.views.has(name);
	}

	// ========================================================
	// Frame Updates
	// ========================================================

	update(frame) {
		const view = this.getActiveView();

		if (!view) {
			return this;
		}

		view.update(frame);

		return this;
	}

	// ========================================================
	// Scene
	// ========================================================

	addToScene(scene) {
		for (const view of this.views.values()) {
			if (typeof view.addToScene === "function") {
				view.addToScene(scene);
			}
		}

		return this;
	}

	removeFromScene(scene) {
		for (const view of this.views.values()) {
			if (typeof view.removeFromScene === "function") {
				view.removeFromScene(scene);
			}
		}

		return this;
	}

	// ========================================================
	// Cleanup
	// ========================================================

	dispose() {
		for (const view of this.views.values()) {
			if (typeof view.dispose === "function") {
				view.dispose();
			}
		}

		this.views.clear();
		this.activeViewName = null;
	}
}
