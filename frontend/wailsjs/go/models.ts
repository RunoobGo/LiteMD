export namespace config {
	
	export class Config {
	    theme: string;
	    fontFamily: string;
	    fontSize: number;
	    recentFiles: string[];
	    windowWidth: number;
	    windowHeight: number;
	    keyMap: string;
	    customCssPath: string;
	    // Go type: time
	    lastUpdateCheck: any;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.theme = source["theme"];
	        this.fontFamily = source["fontFamily"];
	        this.fontSize = source["fontSize"];
	        this.recentFiles = source["recentFiles"];
	        this.windowWidth = source["windowWidth"];
	        this.windowHeight = source["windowHeight"];
	        this.keyMap = source["keyMap"];
	        this.customCssPath = source["customCssPath"];
	        this.lastUpdateCheck = this.convertValues(source["lastUpdateCheck"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace main {
	
	export class AppInfo {
	    name: string;
	    version: string;
	    os: string;
	
	    static createFrom(source: any = {}) {
	        return new AppInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.version = source["version"];
	        this.os = source["os"];
	    }
	}
	export class FilePayload {
	    path: string;
	    content: string;
	    modified: number;
	
	    static createFrom(source: any = {}) {
	        return new FilePayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.modified = source["modified"];
	    }
	}

}

