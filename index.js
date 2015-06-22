var request = require('request');
var cheerio = require('cheerio');
var fs = require('fs');
var url = require('url');
var _ = require('underscore');
var jade = require('jade');
var highlight = require('highlight.js');
var archiver = require('archiver');
var Promise = require('promise');
var Queue = require('promise-queue');

var P = {
    request: Promise.denodeify(request)
};

var util = require('./lib/util');
var parser = require('./lib/parser');

const URI_OVERVIEW = 'http://www.objc.io/issues/';

/**
 *
 * @return {Rx.IPromise<R>}
 */
function getIssues() {
    return P.request({
        uri: URI_OVERVIEW,
        gzip: true
    }).then(function(arguments) {
        return parser.parseIssueOverview(URI_OVERVIEW, arguments.body);
    });
}

function getFullIssueDescription(issueUri) {
    return P.request({
        uri: issueUri,
        gzip: true
    }).then(function(arguments) {

        var $ = cheerio.load(arguments.body);

        var issue = {
            number: $('.c-issue__header__number').text().trim(),
            name: $('.c-issue__header__name').text().trim(),
            slug: util.getSlugfromUri(issueUri),
            date: $('.c-issue__header__date').text().trim(),
            coverUri: url.resolve(issueUri, $('.c-issue__cover img').attr('src')),
            articles: {}
        };

        $('.c-issue__article').each(function(i, el) {
            var resolvedUri = url.resolve(issueUri, $(el).find('a').first().attr('href'));

            issue.articles[i] = {
                slug: util.getSlugfromUri(resolvedUri),
                title: $(el).find('.c-issue__article__name').text().trim(),
                uri: resolvedUri
            };
        });

        return issue;
    });
}

function getArticle(articleUri) {
    return P.request({
        uri: articleUri,
        gzip: true
    }).then(function(arguments) {
        var body = arguments.body.replace('<hr>', '<hr/>');

        var $ = cheerio.load(body, {xmlMode: true});
        var $text = $('.c-text');

        var article = {
            $: $,
            slug: util.getSlugfromUri(articleUri),
            title: $('.c-article__header__title').text().trim(),
            authors: $('.c-article__header__byline a')
                .map(function(i, anchorEl) {
                    var $anchor = $(anchorEl);
                    return {
                        name: $anchor.text(),
                        uri: url.resolve(articleUri, $anchor.attr('href'))
                    };
                })
                .get()
        };

        $text.find('a[rev]').attr('rev', null);

        $text.find('pre > code').each(function() {
            var codeEl = $(this);
            var lang = codeEl.attr('class');

            if (lang === undefined) {
                return;
            }

            var hl = highlight.highlightAuto(codeEl.text(), [lang]);

            codeEl.empty().append(hl.value).addClass('hljs');
        });

        $text.find('a').each(util.resolveUriAttribute($, articleUri, 'href'));
        $text.find('img').each(util.resolveUriAttribute($, articleUri, 'src'));

        article.$text = $text;

        return article;
    });
}


function downloadIssueWithUrl(issueUri) {
    console.log('Downloading ' + issueUri);
    return new Promise(function(resolve, reject) {
        epubArchive = archiver.create('zip')
            .file(__dirname + '/skeleton/mimetype', {name: 'mimetype', store: true})
            .bulk([
                {expand: true, cwd: __dirname + '/skeleton', src: ['META-INF/**', 'OEBPS/**']}
            ]);

        getFullIssueDescription(issueUri)
            .done(function(issue) {
                var outputStream = fs.createWriteStream(process.cwd() + '/' + issue.slug + '.epub');
                outputStream.on('close', function() {
                    console.log('  DONE');
                    resolve();
                });
                epubArchive.pipe(outputStream);

                var epub = {
                    title: issue.name,
                    manifest: [],
                    spine: [],
                    addItem: function(id, properties) {
                        if (properties === undefined || properties === null) {
                            properties = false;
                        }
                        this.spine.push({id: id, properties: properties});
                    },
                    addFile: function(filename) {
                        var id = 'file-' + (this.manifest.length);

                        this.manifest.push({
                            id: id,
                            href: filename,
                            mediaType: util.getMimeType(filename)
                        });

                        return id;
                    }
                };

                epub.addFile('fonts/Roboto-Bold.ttf');
                epub.addFile('fonts/RobotoMono-Regular.ttf');
                epub.addFile('styles/main.css');
                epub.manifest.push({
                    id: 'toc',
                    href: '01-toc.html',
                    mediaType: 'application/xhtml+xml',
                    properties: 'nav'
                });
                epub.manifest.push({
                    id: 'cover-page',
                    href: '00-cover.html',
                    mediaType: 'application/xhtml+xml'
                });

                epubArchive.append(request(issue.coverUri), {name: 'OEBPS/images/cover.jpg'});
                epub.manifest.push({
                    id: 'cover',
                    href: 'images/cover.jpg',
                    mediaType: 'image/jpeg',
                    properties: 'cover-image'
                });

                var contentTemplate = jade.compileFile(__dirname + '/template/content.opf.jade', {pretty: true});
                var articleTemplate = jade.compileFile(__dirname + '/template/article.jade', {pretty: true});

                Promise.all(_.map(issue.articles, function(article) {
                    return getArticle(article.uri)
                }))
                    .done(function(articles) {

                        var images = [];
                        var uriMappings = {};
                        _.each(articles, function(article, no) {
                            article.id = 'ch-' + no;
                            article.filename = (10 + no) + '-' + article.slug + '.html';
                            uriMappings[article.uri] = article.filename;

                            images.push(article.$text.find('img').map(function() {
                                return article.$(this).attr('src');
                            }).get());
                        });

                        images = _.flatten(images);
                        _.each(images, function(uri) {
                            var filename = util.getSlugfromUri(uri);
                            var path = 'images/' + filename;

                            uriMappings[uri] = path;
                            epubArchive.append(request(uri), {name: 'OEBPS/' + path});
                            epub.addFile(path);
                        });

                        _.each(articles, function(article) {
                            util.remapAssets(article.$, article.$text, uriMappings);

                            article.text = article.$text.html();
                            epubArchive.append(articleTemplate({article: article}), {name: 'OEBPS/' + article.filename});
                            var id = epub.addFile(article.filename);
                            epub.addItem(id);
                        });

                        epubArchive.append(contentTemplate(epub), {name: 'OEBPS/content.opf'});
                        epubArchive.finalize();
                    });

            }, function(err) {
                console.error(err);
            });
    });
}

function downloadIssueWithNumber(no) {
    getIssues()
        .done(function(issues) {
            var issueToGet = _.findWhere(issues, {id: no});

            downloadIssueWithUrl(issueToGet.uri);
        }, function(err) {
            console.error(err);
        });
}

function downloadAllIssues() {
    getIssues()
        .done(function(issues) {
            var queue = new Queue(1);
            _.each(issues, function(issue) {
                queue.add(function() {
                    return downloadIssueWithUrl(issue.uri);
                });
            });
        }, function(err) {
            console.error(err);
        });
}

downloadAllIssues(1);
//downloadAllIssues();
