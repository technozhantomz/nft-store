const express = require('express');
const { restrict, checkAccess } = require('../lib/auth');
const escape = require('html-entities').AllHtmlEntities;
const colors = require('colors');
const bcrypt = require('bcryptjs');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mime = require('mime-type/with-db');
const csrf = require('csurf');
const util = require('util');
const stream = require('stream');
const PeerplaysService = require('../services/PeerplaysService');
const peerplaysService = new PeerplaysService();
const config = require('../config/settings');
const { validateJson } = require('../lib/schema');
const {
    clearSessionValue,
    mongoSanitize,
    getThemes,
    getId,
    allowedMimeType,
    fileSizeLimit,
    checkDirectorySync,
    sendEmail
} = require('../lib/common');
const {
    getConfig,
    updateConfig
} = require('../lib/config');
const {
    sortMenu,
    getMenu,
    newMenu,
    updateMenu,
    deleteMenu,
    orderMenu
} = require('../lib/menu');
const {
  getSort,
  paginateProducts
} = require('../lib/paginate');
const ObjectId = require('mongodb').ObjectID;
const router = express.Router();
const csrfProtection = csrf({ cookie: true });

// Regex
const emailRegex = /\S+@\S+\.\S+/;
const numericRegex = /^\d*\.?\d*$/;

const getAllOfferHistory = async (start = 0) => {
  const offerHistories = [];
  const { result } = await peerplaysService.getBlockchainData({
      api: 'database',
      method: 'list_offer_history',
      params: [`2.24.${start}`, 100]
  });

  const params = [];

  for(let i = 0; i < result.length; i++){
      params.push(...result[i].item_ids);
  }
  
  let nfts;

  if(params.length > 0){
    nfts = await peerplaysService.getBlockchainData({
        api: 'database',
        method: 'get_objects',
        'params[0][]': params
    });
  }

  if(nfts){
      for(let i = 0; i < result.length; i++){
          result[i].nft_metadata_ids = nfts.result.filter((nft) => result[i].item_ids.includes(nft.id)).map(({ nft_metadata_id }) => nft_metadata_id);

          result[i].minimum_price.amount = result[i].minimum_price.amount / Math.pow(10, config.peerplaysAssetPrecision);
          result[i].maximum_price.amount = result[i].maximum_price.amount / Math.pow(10, config.peerplaysAssetPrecision);
      }
  }

  offerHistories.push(...result);

  if(result.length < 100){
      return offerHistories;
  }

  const newStart = parseInt(result[99].id.split('.')[2]) + 1;

  offerHistories.push(...await getAllOfferHistory(newStart));
  return offerHistories;
};

// Admin section
router.get('/admin', restrict, (req, res, next) => {
    res.redirect('/admin/dashboard');
});

// logout
router.get('/admin/logout', (req, res) => {
    req.session.user = null;
    req.session.message = null;
    req.session.messageType = null;
    res.redirect('/');
});

// Used for tests only
if(process.env.NODE_ENV === 'test'){
    router.get('/admin/csrf', csrfProtection, (req, res, next) => {
        res.json({
            csrf: req.csrfToken()
        });
    });
}

// login form
router.get('/admin/login', async (req, res) => {
    const db = req.app.db;

    const userCount = await db.users.countDocuments({});
    // we check for a user. If one exists, redirect to login form otherwise setup
    if(userCount && userCount > 0){
        // set needsSetup to false as a user exists
        req.session.needsSetup = false;
        res.render('login', {
            title: 'Login',
            language: req.cookies.locale || config.defaultLocale,
            referringUrl: req.header('Referer'),
            config: req.app.config,
            message: clearSessionValue(req.session, 'message'),
            messageType: clearSessionValue(req.session, 'messageType'),
            helpers: req.handlebars.helpers,
            pageUrl: req.originalUrl,
            showFooter: 'showFooter'
        });
    }else{
        // if there are no users set the "needsSetup" session
        req.session.needsSetup = true;
        res.redirect('/admin/setup');
    }
});

// login the user and check the password
router.post('/admin/login_action', async (req, res) => {
    const db = req.app.db;
   if(!req.body.email){
    res.status(400).json({ message: 'Enter Email.' });
    return;
   }
   if(!req.body.password){
    res.status(400).json({ message: 'Enter password.' });
    return;
   }
    const user = await db.users.findOne({ userEmail: mongoSanitize(req.body.email) });
    if(!user || user === null){
        res.status(400).json({ message: 'A user with that email does not exist.' });
        return;
    }

    // we have a user under that email so we compare the password
    bcrypt.compare(req.body.password, user.userPassword)
        .then(async (result) => {
            if(result){
                const accessToken = await peerplaysService.loginAndJoinApp({
                    login: req.body.email,
                    password: req.body.password
                });

                const userObj = {
                    ...user,
                    peerIDAccessToken: accessToken.result.token,
                    peerIDRefreshToken: accessToken.result.refresh_token,
                    peerIDTokenExpires: accessToken.result.expires
                };

                if(!user.peerplaysAccountId) {
                    peerIdUser = await peerplaysService.signIn({
                        login: req.body.email,
                        password: req.body.password
                    });
        
                    userObj['peerplaysAccountId'] = peerIdUser.result.peerplaysAccountId;
                    userObj['peerplaysAccountName'] = peerIdUser.result.peerplaysAccountName;
                }
      
                const schemaResult = validateJson('editUser', userObj);
                if(!schemaResult.result){
                    console.log('errors', schemaResult.errors);
                    res.status(400).json(schemaResult.errors);
                    return;
                }
        
                await db.users.findOneAndUpdate(
                      { _id: getId(user._id) },
                      {
                          $set: userObj
                      }, { multi: false, returnOriginal: false }
                );

                req.session.user = req.body.email;
                req.session.usersName = user.usersName;
                req.session.userId = user._id.toString();
                req.session.isAdmin = user.isAdmin;

                delete req.session.customerPresent;
                delete req.session.customerId;
                delete req.session.customerEmail;
                delete req.session.customerCompany;
                delete req.session.customerFirstname;
                delete req.session.customerLastname;
                delete req.session.customerAddress1;
                delete req.session.customerAddress2;
                delete req.session.customerCountry;
                delete req.session.customerState;
                delete req.session.customerPostcode;
                delete req.session.customerPhone;
                delete req.session.peerplaysAccountId;
                delete req.session.peerIDAccessToken;
                delete req.session.peerIDTokenExpires;

                res.status(200).json({ message: 'Login successful' });
                return;
            }
            // password is not correct
            res.status(400).json({ message: 'Access denied. Check password and try again.' });
        });
});

// setup form is shown when there are no users setup in the DB
router.get('/admin/setup', async (req, res) => {
    const db = req.app.db;

    const userCount = await db.users.countDocuments({});
    // dont allow the user to "re-setup" if a user exists.
    // set needsSetup to false as a user exists
    req.session.needsSetup = false;
    if(userCount === 0){
        req.session.needsSetup = true;
        res.render('setup', {
            title: 'Setup',
            config: req.app.config,
            language: req.cookies.locale || config.defaultLocale,
            helpers: req.handlebars.helpers,
            message: clearSessionValue(req.session, 'message'),
            messageType: clearSessionValue(req.session, 'messageType'),
            pageUrl: req.originalUrl,
            showFooter: 'showFooter'
        });
        return;
    }
    res.redirect('/admin/login');
});

// insert a user
router.post('/admin/setup_action', async (req, res) => {
    const db = req.app.db;

    if(req.body.userPassword && !req.body.userPassword.match(/^(?=.*[a-zA-Z])(?=.*[0-9])(?=.*[!@#\\$%\\^&\\*])[a-zA-Z0-9!@#\\$%\\^&\\*]+$/)) {
        res.status(400).json({
            message: 'Password should contain an alphabet, a number and a special character (!@#$%^&*)'
        });
        return;
    }

    const doc = {
        usersName: req.body.usersName,
        userEmail: req.body.userEmail,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        userPassword: bcrypt.hashSync(req.body.userPassword, 10),
        isAdmin: true,
        isOwner: true
    };

    // check for users
    const userCount = await db.users.countDocuments({});
    if(userCount === 0){
        let peerIdUser;
        try{
            peerIdUser = await peerplaysService.register({
                email: req.body.userEmail,
                password: req.body.userPassword
            });
        }catch(ex) {
            if(ex.message.email && ex.message.email === "Email already exists") {
                peerIdUser = await peerplaysService.signIn({
                    login: req.body.userEmail,
                    password: req.body.userPassword
                });
            } else {
              console.error(ex.message);
              if(typeof ex.message === 'string') {
                res.status(400).json({message: 'PeerID Sign-up error: ' + ex.message});
              } else {
                res.status(400).json({ message: 'PeerID Sign-up error: ' + Object.values(ex.message) });
              }
              return;
            }
        }
        // email is ok to be used.
        try{
            const accessToken = await peerplaysService.loginAndJoinApp({
                login: req.body.userEmail,
                password: req.body.userPassword
            });

            doc['peerplaysAccountId'] = peerIdUser.result.peerplaysAccountId;
            doc['peerplaysAccountName'] = peerIdUser.result.peerplaysAccountName;
            doc['peerIDAccessToken'] = accessToken.result.token;
            doc['peerIDRefreshToken'] = accessToken.result.refresh_token;
            doc['peerIDTokenExpires'] = accessToken.result.expires;

            await db.users.insertOne(doc);
            res.status(200).json({ message: 'User account inserted' });
            return;
        }catch(ex){
            console.error(colors.red(`Failed to insert user: ${ex}`));
            res.status(200).json({ message: 'Setup failed' });
            return;
        }
    }
    res.status(200).json({ message: 'Already setup.' });
});

// dashboard
router.get('/admin/dashboard', csrfProtection, restrict, async (req, res) => {
    const db = req.app.db;

    let productsSold = [], topProducts = [];
    const products = await paginateProducts(true, db, 1, {productPublished: true}, getSort(), req);
    const allProductsInDB = await db.products.find({}).toArray();
    const nftMetadataIds = allProductsInDB.map(({nftMetadataID}) => nftMetadataID);

    if(nftMetadataIds && nftMetadataIds.length > 0) {
        const metadatas = await peerplaysService.getBlockchainData({
            api: 'database',
            method: 'get_objects',
            'params[0][]': nftMetadataIds
        });
    
        const offerHistories = await getAllOfferHistory();

        if(offerHistories && offerHistories.length > 0) {
            productsSold = offerHistories.filter((offer) => offer.result === 'Expired' && offer.nft_metadata_ids ? offer.nft_metadata_ids.some((id) => nftMetadataIds.includes(id)) : false);
        }

        for(let i = 0; i < productsSold.length; i++) {
            productsSold[i].data = allProductsInDB.find((nft) => nft.nftMetadataID === productsSold[i].nft_metadata_ids[0]);

            productsSold[i].metadata = metadatas.result.find((meta) => meta.id === productsSold[i].data.nftMetadataID);
            productsSold[i].nftIds = productsSold[i].item_ids.join();

            if(productsSold[i].hasOwnProperty('bidder')) {
                const bidder = await db.customers.findOne({peerplaysAccountId: productsSold[i].bidder});
                productsSold[i].bidder = `${bidder.firstName} ${bidder.lastName}`;
                productsSold[i].bid_price.amount = productsSold[i].bid_price.amount / Math.pow(10, config.peerplaysAssetPrecision);
            }

            if(productsSold[i].metadata && productsSold[i].metadata.base_uri.includes('/uploads/')){
                productsSold[i].base_uri = `${req.protocol}://${req.get('host')}/imgs${productsSold[i].metadata.base_uri.split('/uploads')[1]}`;
            }else{
                productsSold[i].base_uri = productsSold[i].metadata.base_uri;
            }
        }

        topProducts = Object.values(productsSold.reduce((obj, nft) => {
            obj[nft.item_ids[0]] = {
                ...nft,
                count: obj[nft.item_ids[0]] ? obj[nft.item_ids[0]].count + 1 : 1
            };
            return obj;
        }, {}));

        topProducts = topProducts.sort((a,b) => b.count - a.count).slice(0, 5);
    }

    // Collate data for dashboard
    const dashboardData = {
        productsCount: products.data? products.data.length : 0,
        // ordersCount: await db.orders.countDocuments({}),
        // ordersAmount: await db.orders.aggregate([{ $match: {} },
        //     { $group: { _id: null, sum: { $sum: '$orderTotal' } }
        // }]).toArray(),
        productsSold,
        productsSoldCount: productsSold.length,
        topProducts
    };

    res.render('dashboard', {
        title: 'Cart dashboard',
        session: req.session,
        language: req.cookies.locale || config.defaultLocale,
        admin: true,
        dashboardData,
        themes: getThemes(),
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        pageUrl: req.originalUrl,
        csrfToken: req.csrfToken()
    });
});

// settings
router.get('/admin/settings', csrfProtection, restrict, (req, res) => {
    res.render('settings', {
        title: 'Cart settings',
        session: req.session,
        language: req.cookies.locale || config.defaultLocale,
        admin: true,
        themes: getThemes(),
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        footerHtml: typeof req.app.config.footerHtml !== 'undefined' ? escape.decode(req.app.config.footerHtml) : null,
        googleAnalytics: typeof req.app.config.googleAnalytics !== 'undefined' ? escape.decode(req.app.config.googleAnalytics) : null,
        pageUrl: req.originalUrl,
        csrfToken: req.csrfToken()
    });
});

// redeem requests
router.get('/admin/redemptions', restrict, checkAccess, async (req, res) => {
    const db = req.app.db;

    const redemptions = await db.redemption.find({}).toArray();

    await Promise.all(redemptions.map(async (redemption) => {
        const customer = await db.customers.findOne({_id: getId(redemption.customer)});
        redemption.customer = customer
    }));

    res.render('redemptions', {
        title: 'Redeem Requests',
        config: req.app.config,
        language: req.cookies.locale || config.defaultLocale,
        helpers: req.handlebars.helpers,
        redemptions,
        admin: true,
        session: req.session,
        themes: getThemes(),
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        pageUrl: req.originalUrl,
        showFooter: 'showFooter'
    });
    return;
});

// create API key
router.post('/admin/createApiKey', restrict, checkAccess, async (req, res) => {
    const db = req.app.db;
    const result = await db.users.findOneAndUpdate({
        _id: ObjectId(req.session.userId),
        isAdmin: true
    }, {
        $set: {
            apiKey: new ObjectId()
        }
    }, {
        returnOriginal: false
    });

    if(result.value && result.value.apiKey){
        res.status(200).json({ message: 'API Key generated', apiKey: result.value.apiKey });
        return;
    }
    res.status(400).json({ message: 'Failed to generate API Key' });
});

// settings update
router.post('/admin/settings/update', restrict, checkAccess, (req, res) => {
    const result = updateConfig(req.body);
    if(result === true){
        req.app.config = getConfig();
        res.status(200).json({ message: 'Settings successfully updated' });
        return;
    }
    res.status(400).json({ message: 'Permission denied' });
});

// settings menu
router.get('/admin/settings/menu', csrfProtection, restrict, async (req, res) => {
    const db = req.app.db;
    res.render('settings-menu', {
        title: 'Cart menu',
        session: req.session,
        language: req.cookies.locale || config.defaultLocale,
        admin: true,
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        menu: sortMenu(await getMenu(db)),
        pageUrl: req.originalUrl,
        csrfToken: req.csrfToken()
    });
});

// page list
router.get('/admin/settings/pages', csrfProtection, restrict, async (req, res) => {
    const db = req.app.db;
    const pages = await db.pages.find({}).toArray();

    res.render('settings-pages', {
        title: 'Static pages',
        pages: pages,
        session: req.session,
        language: req.cookies.locale || config.defaultLocale,
        admin: true,
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        menu: sortMenu(await getMenu(db)),
        pageUrl: req.originalUrl,
        csrfToken: req.csrfToken()
    });
});

// pages new
router.get('/admin/settings/pages/new', csrfProtection, restrict, checkAccess, async (req, res) => {
    const db = req.app.db;

    res.render('settings-page', {
        title: 'Static pages',
        session: req.session,
        language: req.cookies.locale || config.defaultLocale,
        admin: true,
        button_text: 'Create',
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        menu: sortMenu(await getMenu(db)),
        pageUrl: req.originalUrl,
        csrfToken: req.csrfToken()
    });
});

// pages editor
router.get('/admin/settings/pages/edit/:page', csrfProtection, restrict, checkAccess, async (req, res) => {
    const db = req.app.db;
    const page = await db.pages.findOne({ _id: getId(req.params.page) });
    const menu = sortMenu(await getMenu(db));
    if(!page){
        res.status(404).render('error', {
            title: '404 Error - Page not found',
            config: req.app.config,
            message: '404 Error - Page not found',
            helpers: req.handlebars.helpers,
            showFooter: 'showFooter',
            menu
        });
        return;
    }

    res.render('settings-page', {
        title: 'Static pages',
        page: page,
        button_text: 'Update',
        session: req.session,
        language: req.cookies.locale || config.defaultLocale,
        admin: true,
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        menu,
        pageUrl: req.originalUrl,
        csrfToken: req.csrfToken()
    });
});

// insert/update page
router.post('/admin/settings/page', restrict, checkAccess, async (req, res) => {
    const db = req.app.db;

    const doc = {
        pageName: req.body.pageName,
        pageSlug: req.body.pageSlug,
        pageEnabled: req.body.pageEnabled,
        pageContent: req.body.pageContent
    };

    if(req.body.pageId){
        // existing page
        const page = await db.pages.findOne({ _id: getId(req.body.pageId) });
        if(!page){
            res.status(400).json({ message: 'Page not found' });
            return;
        }

        try{
            const updatedPage = await db.pages.findOneAndUpdate({ _id: getId(req.body.pageId) }, { $set: doc }, { returnOriginal: false });
            res.status(200).json({ message: 'Page updated successfully', pageId: req.body.pageId, page: updatedPage.value });
        }catch(ex){
            res.status(400).json({ message: 'Error updating page. Please try again.' });
        }
    }else{
        // insert page
        try{
            const newDoc = await db.pages.insertOne(doc);
            res.status(200).json({ message: 'New page successfully created', pageId: newDoc.insertedId });
            return;
        }catch(ex){
            res.status(400).json({ message: 'Error creating page. Please try again.' });
        }
    }
});

// delete a page
router.post('/admin/settings/page/delete', restrict, checkAccess, async (req, res) => {
    const db = req.app.db;

    const page = await db.pages.findOne({ _id: getId(req.body.pageId) });
    if(!page){
        res.status(400).json({ message: 'Page not found' });
        return;
    }

    try{
        await db.pages.deleteOne({ _id: getId(req.body.pageId) }, {});
        res.status(200).json({ message: 'Page successfully deleted' });
        return;
    }catch(ex){
        res.status(400).json({ message: 'Error deleting page. Please try again.' });
    }
});

// new menu item
router.post('/admin/settings/menu/new', restrict, checkAccess, (req, res) => {
    const result = newMenu(req);
    if(result === false){
        res.status(400).json({ message: 'Failed creating menu.' });
        return;
    }
    res.status(200).json({ message: 'Menu created successfully.' });
});

// update existing menu item
router.post('/admin/settings/menu/update', restrict, checkAccess, (req, res) => {
    const result = updateMenu(req);
    if(result === false){
        res.status(400).json({ message: 'Failed updating menu.' });
        return;
    }
    res.status(200).json({ message: 'Menu updated successfully.' });
});

// delete menu item
router.post('/admin/settings/menu/delete', restrict, checkAccess, (req, res) => {
    const result = deleteMenu(req, req.body.menuId);
    if(result === false){
        res.status(400).json({ message: 'Failed deleting menu.' });
        return;
    }
    res.status(200).json({ message: 'Menu deleted successfully.' });
});

// We call this via a Ajax call to save the order from the sortable list
router.post('/admin/settings/menu/saveOrder', restrict, checkAccess, (req, res) => {
    const result = orderMenu(req, res);
    if(result === false){
        res.status(400).json({ message: 'Failed saving menu order' });
        return;
    }
    res.status(200).json({});
});

// validate the permalink
router.post('/admin/validatePermalink', async (req, res) => {
    // if doc id is provided it checks for permalink in any products other that one provided,
    // else it just checks for any products with that permalink
    const db = req.app.db;

    let query = {};
    if(typeof req.body.docId === 'undefined' || req.body.docId === ''){
        query = { productPermalink: req.body.permalink };
    }else{
        query = { productPermalink: req.body.permalink, _id: { $ne: getId(req.body.docId) } };
    }

    const products = await db.products.countDocuments(query);
    if(products && products > 0){
        res.status(400).json({ message: 'Permalink already exists' });
        return;
    }
    res.status(200).json({ message: 'Permalink validated successfully' });
});

// Discount codes
router.get('/admin/settings/discounts', csrfProtection, restrict, checkAccess, async (req, res) => {
    const db = req.app.db;

    const discounts = await db.discounts.find({}).toArray();

    res.render('settings-discounts', {
        title: 'Discount code',
        config: req.app.config,
        session: req.session,
        language: req.cookies.locale || config.defaultLocale,
        discounts,
        admin: true,
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        pageUrl: req.originalUrl,
        csrfToken: req.csrfToken()
    });
});

// Edit a discount code
router.get('/admin/settings/discount/edit/:id', csrfProtection, restrict, checkAccess, async (req, res) => {
    const db = req.app.db;

    const discount = await db.discounts.findOne({ _id: getId(req.params.id) });

    res.render('settings-discount-edit', {
        title: 'Discount code edit',
        session: req.session,
        language: req.cookies.locale || config.defaultLocale,
        admin: true,
        discount,
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        pageUrl: req.originalUrl,
        csrfToken: req.csrfToken()
    });
});

// Update discount code
router.post('/admin/settings/discount/update', restrict, checkAccess, async (req, res) => {
    const db = req.app.db;

     // Doc to insert
     const discountDoc = {
        discountId: req.body.discountId,
        code: req.body.code,
        type: req.body.type,
        value: parseInt(req.body.value),
        start: moment(req.body.start, 'DD/MM/YYYY HH:mm').toDate(),
        end: moment(req.body.end, 'DD/MM/YYYY HH:mm').toDate()
    };

    // Validate the body again schema
    const schemaValidate = validateJson('editDiscount', discountDoc);
    if(!schemaValidate.result){
        res.status(400).json(schemaValidate.errors);
        return;
    }

    // Check start is after today
    if(moment(discountDoc.start).isBefore(moment())){
        res.status(400).json({ message: 'Discount start date needs to be after today' });
        return;
    }

    // Check end is after the start
    if(!moment(discountDoc.end).isAfter(moment(discountDoc.start))){
        res.status(400).json({ message: 'Discount end date needs to be after start date' });
        return;
    }

    // Check if code exists
    const checkCode = await db.discounts.countDocuments({
        code: discountDoc.code,
        _id: { $ne: getId(discountDoc.discountId) }
    });
    if(checkCode){
        res.status(400).json({ message: 'Discount code already exists' });
        return;
    }

    // Remove discountID
    delete discountDoc.discountId;

    try{
        await db.discounts.updateOne({ _id: getId(req.body.discountId) }, { $set: discountDoc }, {});
        res.status(200).json({ message: 'Successfully saved', discount: discountDoc });
    }catch(ex){
        res.status(400).json({ message: 'Failed to save. Please try again' });
    }
});

// Create a discount code
router.get('/admin/settings/discount/new', csrfProtection, restrict, checkAccess, async (req, res) => {
    res.render('settings-discount-new', {
        title: 'Discount code create',
        session: req.session,
        language: req.cookies.locale || config.defaultLocale,
        admin: true,
        message: clearSessionValue(req.session, 'message'),
        messageType: clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        pageUrl: req.originalUrl,
        csrfToken: req.csrfToken()
    });
});

// Create a discount code
router.post('/admin/settings/discount/create', csrfProtection, restrict, checkAccess, async (req, res) => {
    const db = req.app.db;

    // Doc to insert
    const discountDoc = {
        code: req.body.code,
        type: req.body.type,
        value: parseInt(req.body.value),
        start: moment(req.body.start, 'DD/MM/YYYY HH:mm').toDate(),
        end: moment(req.body.end, 'DD/MM/YYYY HH:mm').toDate()
    };

    // Validate the body again schema
    const schemaValidate = validateJson('newDiscount', discountDoc);
    if(!schemaValidate.result){
        res.status(400).json(schemaValidate.errors);
        return;
    }

    // Check if code exists
    const checkCode = await db.discounts.countDocuments({
        code: discountDoc.code
    });
    if(checkCode){
        res.status(400).json({ message: 'Discount code already exists' });
        return;
    }

    // Check start is after today
    if(moment(discountDoc.start).isBefore(moment())){
        res.status(400).json({ message: 'Discount start date needs to be after today' });
        return;
    }

    // Check end is after the start
    if(!moment(discountDoc.end).isAfter(moment(discountDoc.start))){
        res.status(400).json({ message: 'Discount end date needs to be after start date' });
        return;
    }

    // Insert discount code
    const discount = await db.discounts.insertOne(discountDoc);
    res.status(200).json({ message: 'Discount code created successfully', discountId: discount.insertedId });
});

// Delete discount code
router.delete('/admin/settings/discount/delete', restrict, checkAccess, async (req, res) => {
    const db = req.app.db;

    try{
        await db.discounts.deleteOne({ _id: getId(req.body.discountId) }, {});
        res.status(200).json({ message: 'Discount code successfully deleted' });
        return;
    }catch(ex){
        res.status(400).json({ message: 'Error deleting discount code. Please try again.' });
    }
});

// upload the file
const upload = multer({ dest: 'public/uploads/' });
router.post('/admin/file/upload', restrict, checkAccess, upload.single('uploadFile'), async (req, res) => {
    const db = req.app.db;

    if(req.file){
        const file = req.file;

        // Get the mime type of the file
        const mimeType = mime.lookup(file.originalname);

        // Check for allowed mime type and file size
        if(!allowedMimeType.includes(mimeType) || file.size > fileSizeLimit){
            // Remove temp file
            fs.unlinkSync(file.path);

            // Return error
            res.status(400).json({ message: 'File type not allowed or too large. Please try again.' });
            return;
        }

        // get the product form the DB
        const product = await db.products.findOne({ _id: getId(req.body.productId) });
        if(!product){
            // delete the temp file.
            fs.unlinkSync(file.path);

            // Return error
            res.status(400).json({ message: 'File upload error. Please try again.' });
            return;
        }

        const productPath = product._id.toString();
        const uploadDir = path.join('public/uploads', productPath);

        // Check directory and create (if needed)
        checkDirectorySync(uploadDir);

        // Setup the new path
        const imagePath = path.join('/uploads', productPath, file.originalname.replace(/ /g, '_'));

        // save the new file
        const dest = fs.createWriteStream(path.join(uploadDir, file.originalname.replace(/ /g, '_')));
        const pipeline = util.promisify(stream.pipeline);

        try{
            await pipeline(
                fs.createReadStream(file.path),
                dest
            );

            // delete the temp file.
            fs.unlinkSync(file.path);

            // if there isn't a product featured image, set this one
            if(!product.productImage){
                await db.products.updateOne({ _id: getId(req.body.productId) }, { $set: { productImage: imagePath } }, { multi: false });
            }
            res.status(200).json({ message: 'File uploaded successfully' });
        }catch(ex){
            console.log('Failed to upload the file', ex);
            res.status(400).json({ message: 'File upload error. Please try again.' });
        }
    }else{
        // Return error
        console.log('fail', req.file);
        res.status(400).json({ message: 'File upload error. Please try again.' });
    }
});

// delete a file via ajax request
router.post('/admin/testEmail', restrict, (req, res) => {
    const config = req.app.config;
    // TODO: Should fix this to properly handle result
    sendEmail(config.emailAddress, 'expressCart test email', 'Your email settings are working');
    res.status(200).json({ message: 'Test email sent' });
});

router.post('/admin/searchall', restrict, async (req, res, next) => {
    const db = req.app.db;
    const searchValue = req.body.searchValue;
    const limitReturned = 5;

    // Empty arrays
    let customers = [];
    let orders = [];
    let products = [];

    // Default queries
    const customerQuery = {};
    const orderQuery = {};
    const productQuery = {};

    // If an ObjectId is detected use that
    if(ObjectId.isValid(req.body.searchValue)){
        // Get customers
        customers = await db.customers.find({
            _id: ObjectId(searchValue)
        })
        .limit(limitReturned)
        .sort({ created: 1 })
        .toArray();

        // Get orders
        orders = await db.orders.find({
            _id: ObjectId(searchValue)
        })
        .limit(limitReturned)
        .sort({ orderDate: 1 })
        .toArray();

        // Get products
        products = await db.products.find({
            _id: ObjectId(searchValue)
        })
        .limit(limitReturned)
        .sort({ productAddedDate: 1 })
        .toArray();

        return res.status(200).json({
            customers,
            orders,
            products
        });
    }

    // If email address is detected
    if(emailRegex.test(req.body.searchValue)){
        customerQuery.email = searchValue;
        orderQuery.orderEmail = searchValue;
    }else if(numericRegex.test(req.body.searchValue)){
        // If a numeric value is detected
        orderQuery.amount = req.body.searchValue;
        productQuery.productPrice = req.body.searchValue;
    }else{
        // String searches
        customerQuery.$or = [
            { firstName: { $regex: new RegExp(searchValue, 'img') } },
            { lastName: { $regex: new RegExp(searchValue, 'img') } }
        ];
        orderQuery.$or = [
            { orderFirstname: { $regex: new RegExp(searchValue, 'img') } },
            { orderLastname: { $regex: new RegExp(searchValue, 'img') } }
        ];
        productQuery.$or = [
            { productTitle: { $regex: new RegExp(searchValue, 'img') } },
            { productDescription: { $regex: new RegExp(searchValue, 'img') } }
        ];
    }

    // Get customers
    if(Object.keys(customerQuery).length > 0){
        customers = await db.customers.find(customerQuery)
        .limit(limitReturned)
        .sort({ created: 1 })
        .toArray();
    }

    // Get orders
    if(Object.keys(orderQuery).length > 0){
        orders = await db.orders.find(orderQuery)
        .limit(limitReturned)
        .sort({ orderDate: 1 })
        .toArray();
    }

    // Get products
    if(Object.keys(productQuery).length > 0){
        products = await db.products.find(productQuery)
        .limit(limitReturned)
        .sort({ productAddedDate: 1 })
        .toArray();
    }

    return res.status(200).json({
        customers,
        orders,
        products
    });
});

module.exports = router;
