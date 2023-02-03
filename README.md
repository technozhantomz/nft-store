# ExpressNFT

ExpressNFT is an NFT marketplace based on [ExpressCart](https://github.com/mrvautin/expressCart).  It allows a site administrator to deploy their own NFT marketplace in which they or their customers can create, sell, and buy NFTs in a simple, streamlined user interface.

## Installation and Setup

### Dependencies:

#### PeerID:

ExpressNFT needs to be connected to an instance of [PeerID](https://gitlab.com/PBSA/peerid).  PeerID should be installed and configured prior to continuing with the ExpressNFT installation.  PeerID handles the creation of blockchain accounts on behalf of the ExpressNFT customers, and manages the permissions of those accounts so that ExpressNFT can operate on-chain on behalf of customers for NFT related operations.

#### MongoDB

Express NFT also requires a running instances of MongoDB v4.4.x - This can be installed with the following commands:

```
#Importing public gpg key for 4.4 version of mongodb:
curl -fsSL https://www.mongodb.org/static/pgp/server-4.4.asc | sudo apt-key add -

#Adding mongodb 4.4 source.list entry:
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/4.4 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-4.4.list

#Updating local package indexes
sudo apt update 

#Installing mongodb 4.4
sudo apt install mongodb-org
```

### Setup and configuration

#### Add app in PeerID

Your instance of ExpressNFT will need to be registered in PeerID before you begin.  An administrative user logged in to the PeerID instance will "Add an App," which involves providing some details of the ExpressNFT instance that you intend to deploy.  PeerID will then generate a "client secret" which must then be added to the ExpressNFT configuration to enable ExpressNFT to communicate with the PeerID instance.

Since PeerID manages the permissions of the ExpressNFT users' blockchain accounts, PeerID must be made aware of the relevent blockchain operations that ExpressNFT users will need.  When adding the ExpressNFT app to PeerID, be sure to select the following operations:

- `transfer`
- `offer`
- `bid`
- `cancel_offer`
- `nft_metadata_create`
- `nft_metadata_update`
- `nft_mint`

#### Edit config/settings.json

The first section can be filled out with the following - Use the following documentation to set an app password for your email

https://devanswers.co/create-application-specific-password-gmail/

```
    "baseUrl": "<localhost or your domain>",
    "emailHost": "smtp.gmail.com",
    "emailPort": 587,
    "emailSecure": false,
    "emailUser": "hi@testing.com",
    "emailPassword": "this_is_the_smtp/app_password",
    "emailAddress": "hi@testing.com",

```

The database connection string can be left as default - **UNLESS** you are running on a port different than the default

` "databaseConnectionString": "mongodb://localhost:27017/expresscart" ` 

The following requirements come directly from PeerID - You would obtain the following information while registering ExpressNFT app in PeerID

As well, your `peeridRedirectUri` will depend on where ExpressNFT is running - It would be one of the following:

`"peeridRedirectUri": "http://localhost:3000/peerid_auth/redirect"` OR `"peeridRedirectUri": "https://<your_domain>/peerid_auth/redirect"`

```
    "peeridUrl": "<location_of_your_peerid_api>",
    "peeridClientID": "1",
    "peeridClientSecret": "GV1m9hYUwQh5GgWknSVa99rwWzXtnEn82hN7YUD0vV",
    "peeridRedirectUri": "https://<your_domain>/peerid_auth/redirect",
    "peerplaysAssetID": "1.3.0",
    "peerplaysAssetSymbol": "TEST",
    "peerplaysAssetPrecision": 5,
    "peerplaysAccountID": "1.2.39",
```

#### Configure the admin panel

Once the above configuration is complete, and you run the app for the first time, (see next section "Running the app"), navigate to [your.site]/admin in order to setup the administrative account.  Provide a name, email address, and choose a password.  Once configured, you will be able to return to this address to login as the administrator for administrative control and maintenance of the site. You can configure site details, headers, footers, static content, etc., of the site, and view customer and product info.

## Running the app

For quick testing you can start the app with - `npm run dev` 

It is recommended to use pm2 to deploy this for its process management features.  You can use the following:
- `npm install pm2 -g` 
- `pm2 --name NFT-Store --time start app.js`

If running successfully, you will see on stdout (or in the pm2 process logs via `pm2 logs`) something similar to:

```
Setting up indexes..
- Product indexing complete
- Order indexing complete
- Customer indexing complete
- Review indexing complete
NFT Store running on host: http://localhost:1111
```

Note that by default it will serve the app on localhost:1111.  It is recommended to configure an NGINX reverse proxy to provide public access to your site via secured HTTPS.
