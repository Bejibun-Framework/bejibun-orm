<div align="center">

<img src="https://github.com/Bejibun-Framework/bejibun/blob/master/public/images/bejibun.png?raw=true" width="150" alt="Bejibun" />

![GitHub top language](https://img.shields.io/github/languages/top/Bejibun-Framework/bejibun-orm)
![NPM Downloads](https://img.shields.io/npm/d18m/%40bejibun%2Form)
![GitHub issues](https://img.shields.io/github/issues/Bejibun-Framework/bejibun-orm)
![GitHub](https://img.shields.io/github/license/Bejibun-Framework/bejibun-orm)
![GitHub release (latest by date including pre-releases)](https://img.shields.io/github/v/release/Bejibun-Framework/bejibun-orm?display_name=tag&include_prereleases)

</div>

# ORM for Bejibun
ORM for Bejibun Framework.

## Usage

### Installation
Install the package.

```bash
# Using Bun
bun add @bejibun/orm

# Using Bejibun
bun ace install @bejibun/orm
```

### Configuration
The configuration file automatically executed if you are using `ace`.

Or

Add `orm.ts` inside config directory on your project if doesn't exist.

```bash
config/database.ts
```

```ts
import App from "@bejibun/app";
import ORMDriverEnum from "@bejibun/utils/enums/ORMDriverEnum";

const config: Record<string, any> = {
    connection: "local",

    connections: {
        local: {
            driver: ORMDriverEnum.Local,
            path: App.Path.storagePath("orm") // absolute path
        },

        redis: {
            driver: ORMDriverEnum.Redis,
            host: "127.0.0.1",
            port: 6379,
            password: "",
            database: 0
        }
    }
};

export default config;
```

You can pass the value with environment variables.

### How to Use
How to use tha package.

```ts
import ORM from "@bejibun/orm";

ORM.connection();
await ORM.remember("key", () => {}, 60 /* seconds */); // any
await ORM.has("key"); // boolean
await ORM.get("key"); // any
await ORM.add("key", "Hello world", 60 /* seconds */); // boolean
await ORM.put("key", "Lorem ipsum", 60 /* seconds */); // boolean
await ORM.forget("key"); // void
await ORM.increment("key"); // number
await ORM.decrement("key"); // number
await ORM.incrementBy("key", 5); // number
await ORM.decrementBy("key", 5); // number
```

## ☕ Support / Donate

If you find this project helpful and want to support it:

[![Donate](https://img.shields.io/badge/Donate-Support%20Me-orange?style=for-the-badge)](https://donate.bejibun.com)

Or you can buy this `$BJBN (Bejibun)` tokens [here](https://pump.fun/coin/CQhbNnCGKfDaKXt8uE61i5DrBYJV7NPsCDD9vQgypump).