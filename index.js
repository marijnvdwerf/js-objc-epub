var request = require('request');
var cheerio = require('cheerio');
var fs = require('fs');
var url = require('url');
var _ = require('underscore');
var jade = require('jade');
var highlight = require('highlight.js');
var archiver = require('archiver');


var overviewUrl = 'http://www.objc.io/issues/';

function getSlugfromUri(issueUri) {
    var components = url.parse(issueUri).pathname.split('/');

    for (var i = components.length - 1; i >= 0; i--) {
        if (components[i].trim() !== '') {
            return components[i];
        }
    }

    return null;
}

function getMimeType(filename) {
    var ext = filename.split('.').pop().toLowerCase();

    switch (ext) {
        case 'png':
            return 'image/png';

        case 'gif':
            return 'image/gif';

        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';

        case 'css':
            return 'text/css';

        case 'otf':
            return 'application/font-sfnt';

        case 'ttf':
            return 'application/x-font-ttf';

        default:
            return false;
    }
}

function downloadIssueWithUrl(issueUri) {
    epubArchive = archiver.create('zip')
        .file(__dirname + '/skeleton/mimetype', {name: 'mimetype', store: true})
        .bulk([
            {expand: true, cwd: __dirname + '/skeleton', src: ['META-INF/**', 'OEBPS/**']}
        ]);

    request({
        uri: issueUri,
        gzip: true
    }, function(error, response, body) {
        if (error) {
            console.error(error);
            return;
        }

        var $ = cheerio.load(body);

        var issue = {
            number: $('.c-issue__header__number').text().trim(),
            name: $('.c-issue__header__name').text().trim(),
            date: $('.c-issue__header__date').text().trim(),
            coverUri: url.resolve(issueUri, $('.c-issue__cover img').attr('src')),
            articles: []
        };

        var slug = getSlugfromUri(issueUri);

        $('.c-issue__article').each(function(i, el) {
            var article = {
                title: $(el).find('.c-issue__article__name').text().trim(),
                uri: url.resolve(issueUri, $(el).find('a').first().attr('href'))
            };

            article.id = 'ch' + i + '-' + getSlugfromUri(article.uri);

            issue.articles.push(article);
        });

        epubArchive.pipe(fs.createWriteStream(process.cwd() + '/' + slug + '.epub'));

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
                    mediaType: getMimeType(filename)
                });
            }
        };

        epubArchive.append(request(issue.coverUri), {name: 'OEBPS/images/cover.jpg'});
        epub.manifest.push({
            id: 'cover',
            href: 'images/cover.jpg',
            mediaType: 'image/jpeg',
            properties: 'cover-image'
        });

        var contentTemplate = jade.compileFile(__dirname + '/template/content.opf.jade', {pretty: true});
        var articleTemplate = jade.compileFile(__dirname + '/template/article.jade', {pretty: true});

        var saveContent = _.after(issue.articles.length, function() {
            epubArchive.append(contentTemplate(epub), {name: 'OEBPS/content.opf'});
            epubArchive.finalize();
        });

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

        epub.addItem('cover-page', 'page-spread-right rendition:layout-pre-paginated');
        epub.addItem('toc');
        _.each(issue.articles, function(article) {
            epub.addItem(article.id);
        });

        var imgCount = 0;

        _.each(issue.articles, function(article, chapterNo) {
            request({
                uri: article.uri,
                gzip: true
            }, function(error, response, body) {
                if (error) {
                    console.error(error);
                    return;
                }

                body = body.replace('<hr>', '<hr/>');

                var $ = cheerio.load(body, {xmlMode: true});
                var $text = $('.c-text');

                article.authors = $('.c-article__header__byline a')
                    .map(function(i, anchorEl) {
                        var $anchor = $(anchorEl);
                        return {
                            name: $anchor.text(),
                            uri: url.resolve(article.uri, $anchor.attr('href'))
                        };
                    })
                    .get();

                $text.find('img').each(function() {
                    var imgEl = $(this);
                    var imageUri = url.resolve(article.uri, imgEl.attr('src'));
                    var filename = getSlugfromUri(imageUri);
                    epubArchive.append(request(imageUri), {name: 'OEBPS/images/' + filename});

                    imgEl.attr('src', 'images/' + filename);

                    epub.manifest.push({
                        id: 'img-' + (imgCount++),
                        href: 'images/' + filename,
                        mediaType: getMimeType(filename)
                    });
                });

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

                $text.find('a').each(function() {
                    var anchorEl = $(this);

                    if (anchorEl.attr('href') === undefined) {
                        return null;
                    }

                    if (anchorEl.attr('href')[0] === '#') {
                        // Ignore local links
                        return;
                    }

                    var fullUri = url.resolve(article.uri, anchorEl.attr('href'));
                    anchorEl.attr('href', fullUri);
                });

                article.text = $text.html();
                var slug = getSlugfromUri(article.uri);

                var filename = (10 + chapterNo) + '-' + slug + '.html';

                epubArchive.append(articleTemplate({article: article}), {name: 'OEBPS/' + filename});
                epub.manifest.push({
                    id: article.id,
                    href: filename,
                    mediaType: 'application/xhtml+xml'
                });
                saveContent();
            });
        });

    });
}

function downloadIssueWithNumber(no) {
    request({
        uri: overviewUrl,
        gzip: true
    }, function(error, response, body) {
        if (error) {
            console.error(error);
            return;
        }

        var $ = cheerio.load(body);
        var issueURI = $('.c-issue-unit[id="' + no + '"]').find('a').first().attr('href');

        downloadIssueWithUrl(url.resolve(overviewUrl, issueURI));
    });
}

function downloadAllIssues() {
    request({
        uri: overviewUrl,
        gzip: true
    }, function(error, response, body) {
        if (error) {
            console.error(error);
            return;
        }

        var $ = cheerio.load(body);
        var issues = $('.c-issue-unit')
            .map(function(i, el) {
                var $issue = $(this);
                return {
                    issue: $issue.attr('id'),
                    uri: url.resolve(overviewUrl, $issue.find('a').first().attr('href'))
                };
            })
            .get();

        console.dir(issues);
        _.each(issues, function(issue) {
            downloadIssueWithUrl(issue.uri);
        });
    });
}

downloadIssueWithNumber(10);
