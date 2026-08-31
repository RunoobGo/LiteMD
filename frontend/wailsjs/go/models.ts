export namespace config {
	
	export class Config {
	    theme: string;
	    fontFamily: string;
	    fontSize: number;
	    recentFiles: string[];
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.theme = source["theme"];
	        this.fontFamily = source["fontFamily"];
	        this.fontSize = source["fontSize"];
	        this.recentFiles = source["recentFiles"];
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

